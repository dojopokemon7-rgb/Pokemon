# Review — Fail-open Redis caching across all server-side data paths

Branch `redis-cache-all` adds fail-open Redis caching to the dashboard SSR read, five
authenticated GET endpoints (collection, want-list, collections) and the three public
card-detail reads (prices/history/population), plus a search cache, with per-user keying,
short TTLs, and best-effort write-path invalidation on every mutation. The implementation
is centralized in one helper (`src/lib/utils/cache.ts`) and one key registry
(`src/lib/redis.ts` `RedisKeys` + `CACHE_TTL`), so a read key and its invalidation cannot
drift. No route or page touches `redis.*` directly — every access goes through the helper.

Watch for: nothing blocking. All six non-negotiable correctness gates (data-leak, fail-open,
invalidation, user-agnostic public caches, no-Scrydex-change, short TTLs) hold under a
line-by-line grep of the new code.

**Verdict**: APPROVED

## High-level view

Every per-user cache key embeds the `userId` (`dashboard:{userId}`, `collection:{userId}`,
`wantlist:{userId}:{intent|all}`, `collections:{userId}`), and the three card-detail caches
plus the search cache are deliberately user-agnostic (keyed by `externalId` / normalized
query params, no userId). The data-leak gate holds: there is no per-user payload under a
user-agnostic key, and no user-agnostic payload that carries private data.

Fail-open is structural rather than per-site: all reads/writes funnel through
`cacheGetJson` / `cacheSetJson` / `invalidateUserCaches`, each of which swallows any Redis
error (offline, timeout, malformed JSON) and warn-logs. A grep of the route/page diffs finds
zero direct `redis.get/set/del` calls, so there is no unwrapped path. Redis down → every
read falls through to the live Prisma query and still returns 200.

Invalidation is wired on every mutation's success path after the DB write commits:
collection item add/sell/update/delete → `{collection, dashboard}`; want-list
add/move/remove → `{wantlist (whole family), dashboard}`; collection create/rename/delete →
`{collections, dashboard}`. TTLs on per-user data are short (≤90s) so even a missed
invalidation self-heals quickly.

The Scrydex credit surface is untouched: zero diff to the credit gate, the approval env/Redis
key, or `/graded`. The three cached card-detail routes are pure DB reads
(`prisma`/`getStoredPopulationReport`) with no new external calls, so caching them has no
credit impact. The search 404 (zero rows) returns before the cache fill, so a mid-sync empty
result is never pinned, and cached search payloads are re-validated with `NormalizedCardSchema`
on read (parse failure treated as a miss).

<details>
<summary>Issues (0)</summary>

No blocking or non-blocking issues found. The implementation matches the plan and satisfies
all nine verification gates.

</details>

<details>
<summary>Details</summary>

### Data-leak gate — per-user keys all carry userId (gate 1, PASS)

Grepping every `RedisKeys.*` builder used for user data in `src/lib/redis.ts`:
`dashboardData(userId) → dashboard:${userId}`, `userCollection(userId) → collection:${userId}`,
`wantList(userId, intent) → wantlist:${userId}:${intent ?? "all"}`,
`collections(userId) → collections:${userId}`, and `wantListPattern(userId) →
wantlist:${userId}:*`. Each embeds the userId as the first dynamic segment. The call sites
confirm the real userId is threaded in: dashboard uses `session.user.id`
(`page.tsx:` cacheKey line), the GET routes use the guard's `userId`
(`collection/route.ts`, `want-list/route.ts`, `collections/route.ts`). The unit test
`tests/unit/cache.test.ts` asserts each per-user key `.toContain(userId)` as a RULE-5
regression guard. No per-user payload is stored under a user-agnostic key.

### Fail-open — structural, no unwrapped Redis call (gate 2, PASS)

`cacheGetJson` wraps `redis.get` + `JSON.parse` in one try/catch and returns `null` on any
error (Redis-down, malformed payload, miss) — a bad payload becomes a miss, never served.
`cacheSetJson` wraps `redis.set` and swallows. `invalidateUserCaches` wraps the whole
delete (including the inner `redis.keys` family scan in its own nested try/catch) and
swallows. A grep of the `src/app` diff for `^\+.*redis\.(get|set|del|keys)` returns zero
hits — no route or page calls Redis directly, so there is no path that can throw past the
helper. The integration test `cache-fallopen.test.ts` makes every redis op reject and
asserts `GET /api/users/me/collection` and `GET /api/cards/[id]/prices` both return 200 with
the live Prisma payload and call `findMany`/`findUnique` exactly once.

### Invalidation — every mutation drops the keys it feeds (gate 3, PASS)

Collection item: `POST .../collection` (guarded by `addedCount > 0`), `POST .../[id]/sell`
(both full and partial branches), and `PATCH/DELETE .../collection/[id]` (all four
success return paths — mark-sold, complete-sale, unsold, general update, and delete) each
call `invalidateUserCaches(userId, ["collection", "dashboard"])`. Want-list:
`POST /api/want-list` and `PATCH/DELETE /api/want-list/[id]` call
`["wantlist", "dashboard"]`, and the helper drops the whole `wantlist:{userId}:*` family so a
move between intent tabs cannot leave a stale list. Collections CRUD:
`POST /api/collections` and `PATCH/DELETE /api/collections/[id]` call
`["collections", "dashboard"]`. All invalidations run after the DB write and before the
response. The dashboard is invalidated by all three mutation families because it reflects
collection values and want counts. `cache-invalidation.test.ts` asserts the collection-create
and want-list-add paths delete the expected keys. With TTLs ≤90s, any invalidation that is
missed self-heals within the TTL window.

### Public caches are user-agnostic (gate 4, PASS)

`cardSearchResult(params)` keys off `game/query(lowercased)/sort/set/rarity/graded/min/max`
only; `cardPrices/cardHistory/cardPopulation` key off `externalId` only. None accept or
embed a userId, and the unit test asserts these keys do not contain a sample userId. The
cached payloads are catalog/price data identical for every user — no private field is
present. Search re-validates cached `cards` with `z.array(NormalizedCardSchema)` on read and
treats a parse failure as a miss.

### Scrydex credit behavior unchanged (gate 5, PASS)

`git diff master --stat` shows no change to `src/app/api/cards/[id]/graded`, the credit gate,
or any `scrydex*` service. The only Scrydex-related lines in the diff are explanatory
comments ("no credit impact", "DB-read-only") and the pre-existing untouched
`scrydexCreditApproval` registry key. The three cached routes call only `prisma` and
`getStoredPopulationReport` (a stored read, no live fetch). `SCRYDEX_LIVE_CREDITS_APPROVED`
and `scrydex:credit-approval` are not referenced by any new code. The gate stays default
DENY.

### TTLs short enough to self-heal (gate 6, PASS)

`CACHE_TTL`: dashboard 90s, userCollection 90s, wantList 60s, collections 60s — all ≤120s,
so missed invalidation is bounded. Public card TTLs (search 300s, prices 300s, history 600s,
population 86400s) are user-agnostic and carry no staleness-leak risk; the 24h population TTL
matches the route's existing `max-age=86400`.

### Registry + docs (gate 7, PASS)

All eight new builders carry doc-comments naming per-user vs user-agnostic classification,
TTL, and what invalidates each. `docs/ARCHITECTURE.md` §Redis keys adds the eight-row key
table plus a "Mutation → invalidated keys" sub-table enumerating all three mutation families,
and notes `/graded` is deliberately uncached.

### Zod re-parse + AGENTS invariants (gate 8, PASS)

Search re-parses cached cards with the same `NormalizedCardSchema` the live path uses. The
per-user DB reads have no output schema; their defensive `JSON.parse` sits inside the helper
try/catch so a malformed payload becomes a miss (never served). Ownership scoping, offset
pagination, and the load-bearing comments (NFR-4 public-route 200-on-error, Scrydex
weeklyChangePct provenance) are preserved — the price route's "never a fabricated number"
comment and the search 404 message are intact. The `redis.keys` family scan carries a
`ponytail:` comment naming the O(keyspace) ceiling and the SCAN/tagged-set upgrade path.

### Test coverage (gate 9, PASS)

Per-user-key-includes-userId: `cache.test.ts` RULE-5 block. Mutation-invalidates-keys:
`cache-invalidation.test.ts` (collection create + want-list add). Redis-down-fall-through:
`cache-fallopen.test.ts` (per-user + card-detail routes). The pre-existing
`history-null-safe` test was updated to mock `@/lib/redis` (permanent miss) so it stays
hermetic now that its route goes through the cache. Recorded evidence: the coder's commit
messages state `npx vitest run tests/unit/cache.test.ts` → 13 passed and
`npm run test:integration` → 96 passed across 14 files. The plan ran lint + type-check +
unit + integration per step; build/e2e were correctly skipped (live DB / standalone build /
external-call risk). Evidence is present and specific; no spot-check was warranted.

### Not re-run

Per the review brief, the build/lint/type-check/test suites the coder recorded were not
re-executed. The commit messages carry concrete pass counts (13 unit, 96 integration) and the
plan documents the per-step verification commands, so no articulable doubt remained that
would justify the one permitted narrow spot-check.

</details>

<details>
<summary>File map</summary>

- `src/lib/redis.ts` — eight new `RedisKeys` builders + `CACHE_TTL` map, doc-commented.
- `src/lib/utils/cache.ts` (new) — `cacheGetJson` / `cacheSetJson` / `invalidateUserCaches`, all fail-open.
- `src/app/(dashboard)/dashboard/page.tsx` — per-user SSR cache around the `Promise.all`.
- `src/app/api/users/me/collection/route.ts` — GET cache + POST invalidation.
- `src/app/api/users/me/collection/[id]/route.ts` — PATCH/DELETE invalidation (all branches).
- `src/app/api/users/me/collection/[id]/sell/route.ts` — sell invalidation (both branches).
- `src/app/api/want-list/route.ts` — GET per-intent cache + POST invalidation.
- `src/app/api/want-list/[id]/route.ts` — PATCH(move)/DELETE invalidation (family).
- `src/app/api/collections/route.ts` — GET cache + POST invalidation.
- `src/app/api/collections/[id]/route.ts` — PATCH/DELETE invalidation.
- `src/app/api/cards/search/route.ts` — user-agnostic search cache + Zod re-parse on read.
- `src/app/api/cards/[id]/prices|history|population/route.ts` — user-agnostic DB-read caches.
- `tests/unit/cache.test.ts`, `tests/integration/cache-invalidation.test.ts`, `tests/integration/cache-fallopen.test.ts` (new), `tests/integration/history-null-safe.test.ts` (hermetic update).
- `docs/ARCHITECTURE.md` — key table + mutation→invalidation sub-table.

Full diff: `git -C d:\Pokemon\.worktrees\redis-cache-all diff master`.

</details>
