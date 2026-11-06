# Real-PostgreSQL concurrency test — sale integrity (Phase 1 fix `3ac5153`)

This document covers the LIVE-Postgres concurrency test that proves the
Phase-1 sale-integrity fix (the guarded atomic-decrement sale path in
`src/app/api/users/me/collection/[id]/sell/route.ts`) actually defends against
oversell under genuinely parallel database connections.

The mocked suite (`tests/integration/collection-sell.test.ts`) proves the
HANDLER LOGIC — status mapping, `$transaction` wrapping, provenance copying.
It cannot prove the GUARD holds under concurrent connections, because that is a
property of Postgres' row-level write locking, not of the TypeScript. This test
fills that gap against a real database.

## How to run

```bash
npm run test:concurrency
```

Requirements: the Docker daemon must be running. Nothing else — the harness
pulls and runs the Postgres image itself.

That single command (`scripts/concurrency-test.mjs`) does, end to end:

1. Force-removes any leftover `dojo-saletest-pg` container (idempotent start).
2. `docker run` a disposable **`postgres:16`** container, loopback-bound to host
   port **5433** (container `5432`), with throwaway credentials and a throwaway
   `dojo_saletest` database.
3. Waits for readiness via `pg_isready` (retry loop, up to 60s).
4. Applies the schema with `prisma db push --skip-generate --accept-data-loss`
   — **schema-only, NO migration history** — against the TEST connection string
   only.
5. Runs the Vitest file `tests/concurrency/collection-sell.pg.test.ts` under its
   own config `vitest.concurrency.config.ts`.
6. **Tears the container down** (in a `finally`, so pass or fail). Idempotent and
   repeatable: run it as many times as you like.

## Postgres version & test DB design

- **Image:** `postgres:16` (pinned).
- **Host port:** `5433` (NOT the default 5432 — avoids clashing with any local
  Postgres), bound to `127.0.0.1` only.
- **Connection string (no secrets of value — throwaway local creds):**
  `postgresql://postgres:postgres@localhost:5433/dojo_saletest`
- **Disposable & isolated:** the container has no named volume, so its data dies
  with it. Every run is a fresh database.

### Safety — this test NEVER touches production

The repo `.env` `DATABASE_URL` / `DIRECT_URL` point at the **production Supabase
DB**. This test:

- **Never reads or uses** the repo `.env` connection strings.
- Injects `DATABASE_URL` + `DIRECT_URL` + `TEST_DATABASE_URL` pointing at the
  local disposable DB **into the child processes' env only** (in
  `scripts/concurrency-test.mjs`) — the repo `.env` is left untouched and is
  never edited.
- Is **opt-in**: the Vitest suite reads `TEST_DATABASE_URL` and **self-skips**
  (`describe.skip`) when it is unset. So `npm run test:unit`,
  `npm run test:integration`, and CI never hit a database and can never reach
  Supabase — only the `test:concurrency` harness, which sets that variable to
  the local DB, ever runs it.

## Why it's a REAL, overlapping concurrency test

- Two **independent `PrismaClient` instances** (separate connection pools) are
  fired with `Promise.all`, so the competing sales genuinely overlap on distinct
  connections — not sequential, not one shared pool.
- It exercises the **exact guarded SQL** the route runs (guarded `updateMany`
  for the full-sale flip; guarded `updateMany` + sold-row `create` inside one
  `$transaction` for the partial sale), replicated verbatim from the route
  source, including the `GuardMissError` sentinel and the 409/500 mapping.
- Assertions read **final DB state back** with a fresh query after each race.

### Approach: replicated guarded SQL (not the real HTTP handler) — and why

The test replicates the route's guarded SQL rather than invoking the Next.js
POST handler. This is the faithful choice here because:

- The real handler reads the `@/lib/db` PrismaClient **singleton**, so two
  concurrent handler calls would share ONE pool — they could not genuinely
  contend on separate connections, which is precisely the race under test.
  Driving two independent clients is the only way to get real parallel
  connections.
- The handler's Redis SETNX idempotency is a UX dedupe, **not** the oversell
  defense, and identical request bodies would collide on its key and MASK the
  concurrency. We deliberately exclude it so the DB guard is what's exercised.
- The replicated sequence is copied byte-for-byte from the route's two branches,
  so it emits the identical SQL the production path emits.

## Scenarios & results

All five pass against the live `postgres:16` DB. Each asserts on rows read back
from Postgres: total sold ≤ original, exact remainder, `isSold`/`quantity`
consistency, no duplicate sold rows, no partial writes on failure, expected
409 conflicts.

| # | Scenario | Asserted outcome |
|---|----------|------------------|
| 1 | qty 5; two simultaneous PARTIAL sales (3 + 3) | exactly one 200 + one 409; one sold row of qty 3; active remainder exactly 2; sold total = 3 ≤ 5 (no oversell) |
| 2 | qty 5; PARTIAL (3) concurrent with FULL (5) | both legal interleavings consistent; FULL-wins → sold 5, no active; PARTIAL-wins → sold 3, active 2; never both commit, never an active qty-0 row |
| 3 | qty 5; two simultaneous FULL sales | exactly one 200 + one 409; the SAME row flipped once (no 2nd row, no double flip); sold total = 5 |
| 4 | qty 5; PARTIAL 2 then a sale of the remaining 3 | the remainder sale takes the full/flip path; no active qty-0 row ever exists; sold total = 5, no active remainder |
| 5 | qty 5; PARTIAL whose sold-row create fails (FK violation) inside the tx | returns 500; the decrement **rolls back** — lot quantity still 5, no sold row |

Scenario 5 logs a `prisma:error` for the deliberate foreign-key violation — that
is expected and is the mechanism that forces the rollback the test then asserts.

**Result: no oversell or consistency bug was found. The fix holds under real
parallel connections.**

## Files

- `tests/concurrency/collection-sell.pg.test.ts` — the test.
- `vitest.concurrency.config.ts` — dedicated `node`-env Vitest config (keeps this
  DB test out of the mocked unit/integration lanes).
- `scripts/concurrency-test.mjs` — the Docker up → `db push` → Vitest → teardown
  harness.
- `package.json` script `test:concurrency`.

## Security follow-up additions (H-1, M-2, M-3)

All three call PRODUCTION code through independent PrismaClient pools (nothing replicated, except the explicitly-labelled NEGATIVE CONTROLS that prove the harness can detect a lost update):

- `scan-allowance.pg.test.ts` - the real `reserveSuccessfulScan(userId, db)` (optional `db` param, defaults to the singleton). Supersedes the "replicated guarded SQL" approach described above for this file.
- `login-lockout.pg.test.ts` - real `recordFailedLogin` / `lockoutAfterSignIn` / `lockoutBeforeSignIn`: no lost updates, mixed-case convergence, lock + `lockedUntil`.
- `admin-login-guard.pg.test.ts` - real admin guard counters: atomic increments, no window extension while locked, expiry recovery, reset, and a genuinely missing table => in-process fallback.
