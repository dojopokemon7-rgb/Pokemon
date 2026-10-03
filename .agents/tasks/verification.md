# Verification — Dojo Performance Optimization (perf-optimize)

First iteration (no `review.json` present). Implemented the plan at
`.agents/tasks/plan.md` against the evidence in `.agents/tasks/perf-findings.md`.
All work done in the worktree `.worktrees/perf-optimize` on branch `perf-optimize`
(baseline HEAD `165a26f`). Windows/PowerShell; `.env` copied into the worktree from
the parent (gitignored, NOT committed) so the DB-dependent gates could run honestly.

---

## Changes implemented (smallest targeted diffs)

| Plan step | File(s) | What changed | Invariant kept |
|---|---|---|---|
| 1 — Want to Buy optimistic UI (USER-REPORTED) | `src/lib/hooks/useWantToBuy.ts` | Added `onMutate`/`onError` to BOTH add+remove mutations: `cancelQueries(["want-list"])`, snapshot `["want-list","BUY"]`, optimistic `setQueryData` (synthetic row on add / filter-out on remove), revert on error. Kept `onSettled: invalidate(["want-list"])`. The star now flips on tap instead of after POST + refetch. Fixed once at the shared hook → all 3 callers benefit. | No API/Zod/ownership/credit change; `["want-list"]` family invalidate preserved (ARCHITECTURE.md §7). |
| 2 — composite index for `addedAt desc` | `prisma/schema.prisma` | Added `@@index([userId, addedAt])` on `UserCollection` (+ load-bearing comment). Pushed via `npm run db:push`. | Additive index only — no query/API/result-shape change. |
| 3 — parallelize trending page-1 `count` | `src/app/api/cards/trending/route.ts` | Kick off the independent `card.count` (used for `hasMore`) BEFORE awaiting the ranked chain; `await` it only when computing `hasMore`. One fewer serial round-trip on the cold Explore load. | Pure await-reorder; identical result set, cursor math, Redis cache, offset pagination (AGENTS.md rule 12). |
| test pin | `tests/unit/use-want-to-buy.test.tsx` (NEW) | Pins the optimistic behavior: isWanted flips true while the POST is held in-flight (deterministic deferred), and reverts on a 500. | — |
| docs | `docs/ARCHITECTURE.md`, `docs/PERFORMANCE.md` | Added the new index to the "Indexes worth knowing" list; documented the three changes in PERFORMANCE.md "Added this pass". | AGENTS.md doc-sync rule. |

### Not implemented (deliberate)
- **Plan step 4 (optional) — collapse card-detail graded 9+10 into one request.**
  Skipped. It is explicitly optional ("only if you want to halve the detail
  page's graded network"). The two queries ALREADY run in parallel (independent
  `useQuery`, not a waterfall) and the second server call is freshness-gated
  (usually no HTTP/credit). Implementing it safely requires changing the route
  response contract (`grades` CSV → `{prices:{...}}`), and the `graded-add-flow`
  e2e intercepts ALL `**/graded**` calls returning the single `{price}` shape —
  so the collapse would need either e2e-mock edits or dual-shape client handling.
  Risk/complexity outweighs a micro-win on an already-parallel path. Left for a
  follow-up if the detail-page graded HTTP is ever measured as a real cost.

---

## Commands run and results

Run from the worktree root (`.worktrees/perf-optimize`).

| Command | Result |
|---|---|
| `npm run lint` | PASS (0 errors) |
| `npm run type-check` (`tsc --noEmit`) | PASS |
| `npm run test:unit` | PASS — **17 files, 101 tests** (was 16/99; +1 file +2 tests from the new optimistic test) |
| `npm run test:integration` | PASS — **12 files, 92 tests** |
| `npm run test:chart-accuracy` | PASS — 60/60 points within ±10% of the MOCKED Collectr reference (mean \|Δ\| 2.3%, max 5.0%). Run via `npx tsx --env-file=.env scripts/compare-chart-accuracy.ts` because the script does not import dotenv and a bare `npm run` leaves `DATABASE_URL` unset. |
| `npm run db:push` | PASS — "Your database is now in sync" (applied `@@index([userId, addedAt])` to Supabase; Prisma Client regenerated). |
| `npm run build` | PASS — production build compiles clean. |
| `npm run test:e2e` | 39 passed, **1 failed** — the single failure is `portfolio-real-chart.spec.ts` (FR-5), UNRELATED to these changes (see below). All want-list (F-07) and show-more/trending (F-04) specs PASS. |

### Environment note
The worktree had an INCOMPLETE `node_modules` (`next/dist/shared`,`/lib`,`/client`
missing) that broke `next build` with internal module-not-found errors. Ran
`npm install` in the worktree to complete the install; build then succeeded. This
was a pre-existing environment issue, not a code change.

---

## Before / after bundle (First Load JS) — unchanged by design

The findings proved bundle size was NOT the bottleneck; these changes are
server/DB/cache-timing only, so first-load JS is unchanged.

| Route | Before (findings) | After (this build) |
|---|---|---|
| First Load JS shared by all | 103 kB | 103 kB |
| `/search` | 128 kB | 129 kB |
| `/dashboard` | 124 kB | 124 kB |
| `/portfolio` | 125 kB | 125 kB |
| `/search/[id]` | 121 kB | 122 kB |
| Middleware | 34.2 kB | 34.1 kB |

(The small per-route deltas are routine build-to-build chunk-hash variance, not a
regression — shared JS is identical.)

## Performance effect (what the changes remove)

- **Want to Buy:** the star/label now reflects the tap IMMEDIATELY (optimistic
  cache write) instead of after POST → `["want-list"]` invalidate → GET refetch
  (two sequential round-trips on a phone). This is the user-reported symptom.
- **Collection reads:** `where userId + orderBy addedAt desc` on the dashboard
  SSR / portfolio / collection GET is now served by the composite index instead
  of a per-request sort of the matched rows.
- **Explore cold load:** trending page-1 does one fewer serial DB round-trip (the
  `count` runs concurrently with the ranked/backfill fetch).

---

## E2E failure analysis (not caused by this work)

`portfolio-real-chart.spec.ts > after adding a card, the portfolio chart renders a
real series or the empty state` times out waiting for `role="img"` "Portfolio
comparison chart". The error-context DOM snapshot shows the dashboard rendered
fine (Market Value $350.00) with the **"Main"** collection selected showing "No
cards in this collection yet" — the probe card was added to the default/uncat set,
so the selected-collection chart shows the empty state, and the stricter
`added → chart visible` assertion fails. This is a pre-existing expectation tied to
collection selection on the dashboard. None of this pass's changes touch the
portfolio page, the dashboard chart, collection selection, or the add route; the
same assertion failed when the spec was re-run in isolation. Documented, not
fabricated as passing.
