# Implementation Plan — Redis caching for ALL server-side data paths

Goal: add fail-open Redis caching to every uncached server data path in the Dojo
PWA (dashboard SSR + 5 API GETs + 3 card-detail reads), with correct per-user
keying, TTLs, and write-path invalidation on every mutation. Redis stays
CACHE-ONLY / OPTIONAL / FAIL-OPEN (AGENTS.md RULE 1). ZERO Scrydex credits — no
external/Scrydex calls, the credit gate stays default DENY, and `/graded` is left
untouched (it routes through the gated `pullAndStoreScrydexPrice`).

All paths are absolute under `d:\Pokemon\.worktrees\redis-cache-all`.

## Design decisions (grounded in the read code)

- **Canonical pattern = the existing `ebay-sold` / `trending` routes.** Read:
  `try { const cached = await redis.get(key); if (cached) return <from cached>; } catch { warn; fall through }`.
  Write: `try { await redis.set(key, JSON.stringify(body), "EX", ttl); } catch { warn }`.
  Every read AND write is individually try/caught so any Redis error (offline,
  timeout, parse) falls through to the live Prisma query. This matches
  AGENTS.md RULE 1 and docs/ARCHITECTURE §6.1 verbatim.
- **Serialize the response BODY, cache the string, re-parse on read.** The
  trending route caches the exact JSON string and returns it directly; for
  routes that must re-shape or re-wrap I cache the plain data object and
  `JSON.parse` on read. Dates: Prisma `Date` fields serialize to ISO strings via
  `JSON.stringify`; the dashboard + collection clients already consume the API
  JSON shape (ISO strings over the wire), so caching the JSON-serialized form
  reproduces the identical shape the live path returns. **Zod re-parse on read:**
  only `/api/cards/search` has a Zod schema for its output (`NormalizedCardSchema`
  via `NormalizedCard[]`); its cached payload is re-validated with that schema on
  read, and a parse failure is treated as a cache miss (fall through to live).
  The per-user DB reads have no output Zod schema today — for those "re-parse"
  means a defensive `JSON.parse` inside the read try/catch so a malformed/legacy
  payload throws → caught → live fall-through (never served).
- **Per-user keys MUST embed userId** (AGENTS.md RULE 5 — a key missing userId
  leaks one user's private data to another). Every per-user builder signature
  starts with `userId`.
- **User-agnostic keys (search, card-detail public reads) MUST NOT include
  userId** — the data is identical for everyone and sharing it is the point.
- **TTLs** follow the existing registry style (short for mutable per-user data so
  the stale window is tiny; medium for public card data). Chosen: dashboard 90s,
  userCollection 90s, wantList 60s, collections 60s, cardSearch 300s (5 min),
  cardPrices 300s, cardHistory 600s (10 min), cardPopulation 86400s (24h, matches
  the route's existing `max-age=86400`).
- **Invalidation on the WRITE path, best-effort.** Every mutation deletes the
  affected per-user keys inside its own try/catch AFTER the DB write commits, so
  a failed delete never fails the mutation but the stale window is minimal. A
  shared helper centralizes the delete sets so a read key and its invalidation
  can never drift.
- **No decomposition into FEATs.** This is one tightly-coupled feature: every
  area shares the single `RedisKeys` registry and the invalidation sets must stay
  consistent with the read keys. Splitting it across independent FEATs would risk
  a read key and its invalidation landing in different units. The existing
  implement/review loop runs this plan.

## Verification commands (discovered in package.json / vitest.config.ts)

- Type: `npm run type-check` (tsc --noEmit)
- Lint: `npm run lint`
- Unit: `npm run test:unit` (vitest run tests/unit src)
- Integration: `npm run test:integration` (vitest run tests/integration)
- Tests mock `@/lib/db`; new cache tests additionally mock `@/lib/redis`
  (`vi.mock("@/lib/redis", ...)` exposing `redis.get/set/del` as `vi.fn()` plus
  the real `RedisKeys`), following the `vi.hoisted` + `vi.mock` pattern in
  `tests/integration/collections.test.ts`.
- Do NOT run `npm run build` / `test:e2e` here (e2e needs a live DATABASE_URL and
  a standalone build; out of scope and would risk external calls).

---

## Plan

- [ ] 1. Extend the `RedisKeys` registry with the new builders + a cache-TTL map.
      Add to the `RedisKeys` object (matching the existing doc-comment style:
      name + TTL + what invalidates each): `dashboardData(userId)` →
      `dashboard:{userId}` (per-user, 90s; invalidated by collection/want-list/
      collections mutations); `userCollection(userId)` → `collection:{userId}`
      (per-user, 90s; invalidated by add/sell/update/delete collection item);
      `wantList(userId, intent?)` → `wantlist:{userId}:{intent|all}` (per-user,
      60s; invalidated by want-list add/move/remove); `wantListPattern(userId)` →
      `wantlist:{userId}:*` (for family invalidation — SCAN-based delete, see
      step 2); `collections(userId)` → `collections:{userId}` (per-user, 60s;
      invalidated by collection create/rename/delete); `cardSearchResult(params)`
      → `card:searchq:{normalizedParams}` (user-agnostic, 300s) where
      normalizedParams is a stable `key=value` join of game/query(lowercased)/
      sort/set/rarity/graded/minPrice/maxPrice (NOT the existing `cardSearch`
      builder, which is the service-layer 24h key — keep both, name the new one
      distinctly); `cardPrices(externalId)` → `card:prices:{externalId}`
      (user-agnostic, 300s); `cardHistory(externalId)` →
      `card:history:{externalId}` (user-agnostic, 600s); `cardPopulation(externalId)`
      → `card:pop:{externalId}` (user-agnostic, 86400s). Add an exported
      `CACHE_TTL` const object holding each numeric TTL so routes import TTLs by
      name instead of hardcoding.
      Files: `d:\Pokemon\.worktrees\redis-cache-all\src\lib\redis.ts`
      Verify: `npm run type-check` passes (new object members type-check; no route
      imports them yet so no behavior change).

- [ ] 2. Create a shared cache helper module with fail-open get/set-JSON wrappers
      and a per-user invalidation function. Add `cacheGetJson<T>(key)` (returns
      `T | null`; `JSON.parse` inside try/catch; any error → `null` = miss),
      `cacheSetJson(key, value, ttlSeconds)` (best-effort `redis.set(key, JSON.stringify(value), "EX", ttl)` in try/catch), and
      `invalidateUserCaches(userId, scopes)` where `scopes` is a set of
      `"collection" | "dashboard" | "wantlist" | "collections"`; it best-effort
      `redis.del(...)`s the matching keys (and for the want-list family uses
      `redis.keys(RedisKeys.wantListPattern(userId))` then `del` the results — a
      dev-scale SCAN is fine here).
      `ponytail:` comment on the `redis.keys` usage noting it is O(keyspace) and
      should move to SCAN/tagged-set invalidation if the keyspace grows large.
      All functions swallow Redis errors (warn-log) so a cache fault never
      propagates.
      Files: `d:\Pokemon\.worktrees\redis-cache-all\src\lib\utils\cache.ts` (new)
      Verify: `npm run type-check` passes.

- [ ] 3. Add a unit test for the cache helper proving fail-open behavior and the
      per-user key classification. Mock `@/lib/redis` so `redis.get` rejects
      (simulated Redis-down): assert `cacheGetJson` resolves to `null` (not a
      throw). Mock `redis.get` returning malformed JSON: assert `null`. Assert
      `RedisKeys.userCollection("u1")`, `.dashboardData("u1")`,
      `.wantList("u1","BUY")`, `.collections("u1")` each CONTAIN `"u1"` (RULE 5
      regression guard) and that `cardSearchResult`/`cardPrices`/`cardHistory`/
      `cardPopulation` keys do NOT contain any userId. Assert
      `invalidateUserCaches` calls `redis.del` with the expected keys and still
      resolves when `redis.del` rejects.
      Files: `d:\Pokemon\.worktrees\redis-cache-all\tests\unit\cache.test.ts` (new)
      Verify: `npm run test:unit` — new tests pass.

- [ ] 4. (Area A) Cache the dashboard SSR Prisma reads per-user, fail-open. In
      `DashboardPage`, after resolving `session`, build
      `key = RedisKeys.dashboardData(session.user.id)`, `cacheGetJson<{rows, collections}>(key)`;
      on hit use it, on miss run the existing `Promise.all([...])` then
      `cacheSetJson(key, { rows, collections }, CACHE_TTL.dashboard)`. Wrap ONLY
      the cache calls such that any Redis error falls through to the live queries
      (the helper already guarantees this) — SSR must never block or throw on a
      cache fault. Keep the exact `select` projections and the `CollectionItem`
      typing. Add a comment documenting the key + that collection/want-list/
      collections mutations invalidate it.
      Files: `d:\Pokemon\.worktrees\redis-cache-all\src\app\(dashboard)\dashboard\page.tsx`
      Verify: `npm run type-check` + `npm run lint` pass.

- [ ] 5. (Area B) Cache `GET /api/users/me/collection` per-user, fail-open. After
      the guard resolves `userId`, read `RedisKeys.userCollection(userId)` via
      `cacheGetJson`; on hit return `NextResponse.json({ items })` from the cached
      value; on miss run the existing `findMany`, then `cacheSetJson(...)` with
      `CACHE_TTL.userCollection` before returning. Leave the existing 500
      try/catch intact (a Redis fault is NOT a 500 — the helper returns null →
      live query).
      Files: `d:\Pokemon\.worktrees\redis-cache-all\src\app\api\users\me\collection\route.ts`
      Verify: `npm run type-check` + `npm run lint` pass.

- [ ] 6. (Area C) Cache `GET /api/want-list` per-user per-intent, fail-open. Build
      `RedisKeys.wantList(userId, intent)` (intent may be undefined → "all").
      Read via `cacheGetJson`; on hit return `{ data: items }`; on miss run
      `listWantList`, then `cacheSetJson(..., CACHE_TTL.wantList)`. Preserve the
      existing catch-all that degrades to `{ data: [] }`. Key is built so a future
      `collectionId` scope can extend the suffix without changing existing keys —
      do NOT implement collectionId scoping now.
      Files: `d:\Pokemon\.worktrees\redis-cache-all\src\app\api\want-list\route.ts`
      Verify: `npm run type-check` + `npm run lint` pass.

- [ ] 7. (Area D) Cache `GET /api/collections` per-user, fail-open. Build
      `RedisKeys.collections(userId)`, read via `cacheGetJson`; on hit return
      `{ data: collections }` (keep the `Cache-Control: no-store` header — that is
      a browser-cache directive, independent of the server Redis cache); on miss
      call `listCollections`, then `cacheSetJson(..., CACHE_TTL.collections)`.
      Files: `d:\Pokemon\.worktrees\redis-cache-all\src\app\api\collections\route.ts`
      Verify: `npm run type-check` + `npm run lint` pass.

- [ ] 8. (Area E) Cache `GET /api/cards/search` by normalized query params,
      user-agnostic, fail-open. After the Zod `SearchQuerySchema` parse succeeds,
      build `RedisKeys.cardSearchResult({ game, query, sort, set, rarity, graded, minPrice, maxPrice })`
      from the PARSED+normalized values (so `?query=Char` and `?query=char`
      collide, matching the existing lowercase convention). Read via
      `cacheGetJson<{cards: NormalizedCard[], source: string}>`; **re-validate the
      cached `cards` with the same `NormalizedCard` shape** (reuse the schema the
      route's `NormalizedCard[]` type comes from — import
      `NormalizedCardSchema` from `@/lib/validators/card.validator` and
      `z.array(...).safeParse`); a parse failure is treated as a miss. On hit
      return the cached envelope with the SAME `Cache-Control` header; on a real
      404 (zero rows) do NOT cache (so a mid-sync empty result isn't pinned) — only
      cache non-empty 200s with `CACHE_TTL.cardSearch`. NO userId in the key.
      Files: `d:\Pokemon\.worktrees\redis-cache-all\src\app\api\cards\search\route.ts`
      Verify: `npm run type-check` + `npm run lint` pass.

- [ ] 9. (Area F) Cache the three public card-detail reads per-card
      (user-agnostic, DB-read-only), fail-open — `/prices`, `/history`,
      `/population`. In each route key by `externalId` (the `[id]` param, which is
      the external id per RULE 3): `RedisKeys.cardPrices(externalId)` /
      `cardHistory(externalId)` / `cardPopulation(externalId)`. Read via
      `cacheGetJson`; on hit return the same envelope the live path returns
      (prices: `{prices, weeklyChangePct}`, history: `{points}`, population:
      `{report, bgsSupported}`) with the existing headers; on miss compute, then
      `cacheSetJson` with the matching TTL (`cardPrices`/`cardHistory`/
      `cardPopulation`). Cache the "not found"/empty result too for prices &
      history (an unknown externalId legitimately returns empty) but keep it short
      via the same TTL. These routes make NO Scrydex calls (pure Prisma /
      `getStoredPopulationReport`), so no credit impact. **Leave `/graded`
      untouched** — it routes through the gated `pullAndStoreScrydexPrice`; adding
      a cache there risks altering gate/freshness behavior.
      Files: `d:\Pokemon\.worktrees\redis-cache-all\src\app\api\cards\[id]\prices\route.ts`,
      `d:\Pokemon\.worktrees\redis-cache-all\src\app\api\cards\[id]\history\route.ts`,
      `d:\Pokemon\.worktrees\redis-cache-all\src\app\api\cards\[id]\population\route.ts`
      Verify: `npm run type-check` + `npm run lint` pass.

- [ ] 10. (Invalidation — collection item mutations) After each successful DB
      write, call `invalidateUserCaches(userId, {"collection","dashboard"})`
      best-effort. Wire into: POST (add) in
      `...\users\me\collection\route.ts` (after the add loop, before the response);
      POST sell in `...\collection\[id]\sell\route.ts` (both full and partial
      branches); PATCH + DELETE in `...\collection\[id]\route.ts` (every success
      return path — mark-sold, unsold, general update, delete). Add a comment at
      each site naming the keys invalidated.
      Files: `d:\Pokemon\.worktrees\redis-cache-all\src\app\api\users\me\collection\route.ts`,
      `d:\Pokemon\.worktrees\redis-cache-all\src\app\api\users\me\collection\[id]\route.ts`,
      `d:\Pokemon\.worktrees\redis-cache-all\src\app\api\users\me\collection\[id]\sell\route.ts`
      Verify: `npm run type-check` + `npm run lint` pass.

- [ ] 11. (Invalidation — want-list mutations) After each successful write call
      `invalidateUserCaches(userId, {"wantlist","dashboard"})` (dashboard counts
      want totals, so invalidate it too). Wire into: POST in `...\want-list\route.ts`;
      PATCH (move) + DELETE in `...\want-list\[id]\route.ts`. The helper deletes the
      whole `wantlist:{userId}:*` family (all intents) so a move between tabs can't
      leave a stale intent list. Comment the mapping at each site.
      Files: `d:\Pokemon\.worktrees\redis-cache-all\src\app\api\want-list\route.ts`,
      `d:\Pokemon\.worktrees\redis-cache-all\src\app\api\want-list\[id]\route.ts`
      Verify: `npm run type-check` + `npm run lint` pass.

- [ ] 12. (Invalidation — collections CRUD) After each successful write call
      `invalidateUserCaches(userId, {"collections","dashboard"})`. Wire into: POST
      in `...\collections\route.ts`; PATCH + DELETE in `...\collections\[id]\route.ts`
      (every success return path). Note the `userId` is already available via
      `guard.session.user.id`. Comment the mapping at each site.
      Files: `d:\Pokemon\.worktrees\redis-cache-all\src\app\api\collections\route.ts`,
      `d:\Pokemon\.worktrees\redis-cache-all\src\app\api\collections\[id]\route.ts`
      Verify: `npm run type-check` + `npm run lint` pass.

- [ ] 13. Add an integration test proving a mutation invalidates its per-user
      keys. Mock `@/lib/db` (Prisma) and `@/lib/redis` (get/set/del/keys as
      `vi.fn()` + real `RedisKeys`), following the `vi.hoisted`+`vi.mock` pattern
      in `tests/integration/collections.test.ts`. Call the collections POST route
      handler (import from the route module) with a valid session guard mocked, and
      assert `redis.del` was called with `RedisKeys.collections(userId)` AND
      `RedisKeys.dashboardData(userId)`. Add one case for a want-list mutation
      asserting the want-list family + dashboard key are invalidated. (Mock
      `requireAuth`/`@/lib/utils/auth-guard` to return a fixed session.)
      Files: `d:\Pokemon\.worktrees\redis-cache-all\tests\integration\cache-invalidation.test.ts` (new)
      Verify: `npm run test:integration` — new tests pass.

- [ ] 14. Add an integration test proving Redis-down fall-through still returns
      live data. Mock `@/lib/db` to return fixed rows and `@/lib/redis` so
      `redis.get` REJECTS (throws). Call `GET /api/users/me/collection` (and one
      card-detail read, e.g. `/prices`) handler and assert the response status is
      200 and the body equals the live Prisma-derived payload (i.e. the Redis
      failure did not block or alter the result). Assert the handler did NOT throw.
      Files: `d:\Pokemon\.worktrees\redis-cache-all\tests\integration\cache-fallopen.test.ts` (new)
      Verify: `npm run test:integration` — new tests pass.

- [ ] 15. Update docs: add every new key to `docs/ARCHITECTURE.md` §6.1 table
      (key, TTL, writer/reader) and add a new "mutation → invalidated keys"
      sub-table enumerating: add/sell/update/delete collection item →
      `collection:{userId}` + `dashboard:{userId}`; want-list add/move/remove →
      `wantlist:{userId}:*` + `dashboard:{userId}`; collection create/rename/delete
      → `collections:{userId}` + `dashboard:{userId}`. Keep AGENTS.md RULE 1/RULE 5
      wording consistent (no rule text change needed; the new keys obey them).
      Files: `d:\Pokemon\.worktrees\redis-cache-all\docs\ARCHITECTURE.md`
      Verify: `npm run lint` passes (markdown is not linted, but confirms no code
      regression); manually confirm the table lists all 8 new builders + the
      invalidation sub-table.

- [ ] 16. Full gate for the touched layers: run `npm run lint`,
      `npm run type-check`, `npm run test:unit`, `npm run test:integration` and
      confirm all pass with the new tests included. Fix any failures before
      declaring done. (Skip `build`/`test:e2e`/`test:chart-accuracy` — out of
      scope, require a live DB / standalone build / would risk external calls.)
      Files: none (verification only)
      Verify: all four commands exit 0; new cache tests appear in the run output.

## Commit boundaries (logical)

1. Steps 1–3: RedisKeys registry + cache helper + helper unit test.
2. Step 4: Area A (dashboard SSR cache).
3. Steps 5–7: Areas B/C/D (per-user GET caches).
4. Step 8: Area E (search cache).
5. Step 9: Area F (card-detail public read caches).
6. Steps 10–12: all mutation invalidation wiring.
7. Steps 13–14: invalidation + fail-open integration tests.
8. Step 15: docs.

## Open assumptions (reasonable, non-blocking)

- Dashboard reflects want-list counts, so want-list mutations invalidate
  `dashboard:{userId}` (brief says "if dashboard reflects want counts"). If a
  reviewer confirms the dashboard does NOT read want data, that one invalidation
  can be dropped — harmless either way (a spurious delete only costs one cache
  miss).
- `/graded` is left uncached per the brief's "if unsure, leave /graded as-is"
  guidance, because its only safe cache (final stored-price result) is entangled
  with the credit gate and the brief forbids altering gate behavior.
- The want-list family invalidation uses `redis.keys(pattern)` (dev-scale);
  flagged with a `ponytail:` comment for a SCAN/tagged-set upgrade if the
  keyspace grows.
