# Implementation Plan — SSR the dashboard comparison-chart history (root-cause flicker fix)

## Goal

Fix the dashboard chart skeleton flicker at its ROOT: server-render the chart's
default-range history data with the page (exactly like the collection rows already
SSR), so the whole dashboard arrives in the first byte with NO post-mount history
fetch and NO skeleton flash on first paint. Front-end + server-component change,
ZERO credits, NO Scrydex/external calls, NO Prisma schema change, NO new dependency.

## Root cause (confirmed in code)

- `src/app/(dashboard)/dashboard/page.tsx` (server component) SSRs `rows` +
  `collections` and passes `rows` as `initialItems` → `DashboardClient`'s
  `useQuery(["collection"])` `initialData`. Stat blocks + card rows paint instantly.
- BUT the chart depends on a SEPARATE client query with NO `initialData`:
  `useQuery({ queryKey: ["portfolio-history", collectionIdsQuery, activeRange], ... })`
  (DashboardClient.tsx ~line 686). It only fetches `GET /api/users/me/collection/history`
  AFTER hydration. While it runs, `chartLoading` is true and `useDelayedFlag(chartLoading, 250)`
  (`showChartSkeleton`) swaps in a grey `<Skeleton>` (DashboardClient.tsx ~line 997),
  then swaps to the real chart when the fetch resolves — that late swap is the flicker.
- Fix: give the chart's DEFAULT (first-render) query key `initialData` computed on
  the server with the page, so on first load `isLoading` is already false and the
  skeleton branch never runs.

## Exact client lines that fix the SSR key (must match these verbatim)

The SSR-computed data only hydrates the first query if the SSR key equals the
client's first `["portfolio-history", collectionIdsQuery, activeRange]` key. From
`src/app/(dashboard)/dashboard/_components/DashboardClient.tsx`:

1. Initial range (default `activeRange`):
   ```ts
   const [activeRange, setActiveRange] = useState<RangeId>("1M");
   ```
   → **default range = `"1M"`**.

2. Initial selection (default `selectedIds` is EMPTY → expands to "all options"):
   ```ts
   const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
   ...
   const activeSelectedIds = useMemo(() => {
     return selectedIds.size === 0 ? new Set(collOptions.map((o) => o.id)) : selectedIds;
   }, [selectedIds, collOptions]);
   ```

3. The query-string the first query uses:
   ```ts
   const collectionIdsQuery = Array.from(activeSelectedIds).join(",");
   ```

4. `collOptions` id ORDER (this is the exact order `collectionIdsQuery` joins on
   first render — the loose bucket FIRST, then named collections in `collectionList`
   order):
   ```ts
   opts.push({ id: "__uncat__", name: hasNamedMain ? "Uncategorized" : "Main", ... }); // FIRST
   ...
   collectionList.forEach((c, i) => { opts.push({ id: c.id, ... }); });                // THEN each named
   ```
   → first-render `collectionIdsQuery` = `["__uncat__", ...collectionList.map(c => c.id)].join(",")`.

5. The query itself (currently NO `initialData`):
   ```ts
   const { data: realHistoriesData, isLoading: historyLoading } = useQuery({
     queryKey: ["portfolio-history", collectionIdsQuery, activeRange],
     queryFn: async () => {
       if (!collectionIdsQuery) return { histories: {} };
       const res = await fetch(`/api/users/me/collection/history?collectionIds=${collectionIdsQuery}&range=${activeRange}`);
       if (!res.ok) throw new Error("Failed to load portfolio history");
       return res.json();
     },
     staleTime: 60_000,
     placeholderData: (prev) => prev,   // KEEP — the blink fix
   });
   ```

### CRITICAL correctness note — reuse ONE function so SSR == client bug-for-bug

The route builds its response as `histories[collId]` for each `collId` in the
`collectionIds` param, where the per-id DB filter is:
`"null"` → `collectionId: null`; `"all"` → no filter; **anything else → `collectionId = collId` literally.**
The client's first-render ids include the SENTINEL `"__uncat__"`, which is NOT
`"null"` — so the route today filters `collectionId = "__uncat__"` (matches no rows)
and returns `histories["__uncat__"] = []`. The chart then reads
`realHistoriesData?.histories?.[opt.id]` with `opt.id === "__uncat__"`, i.e. an empty
series for the loose bucket. **This is the CURRENT behavior and the SSR path MUST
reproduce it identically** (same keys, same empty-for-`__uncat__` result). Therefore
the SSR MUST call the SAME extracted function with the SAME id list the client sends
— do NOT "fix" the `__uncat__`→`null` mismatch here (out of scope; would change
behavior and desync SSR from the client). Extracting one function guarantees SSR and
client agree exactly, flicker or not.

## Design decisions (made here, grounded in the code)

- **One source of truth**: extract the route body into a server-only
  `buildCollectionHistories(userId, collectionIds, range)` and make BOTH the GET route
  and the page call it. Chosen over duplicating the logic in the page (would diverge).
- **Redis**: fold the default histories into the EXISTING per-user `dashboard:<userId>`
  cache payload (extend `DashboardCache`), NOT a new RedisKey. Rationale: that key is
  already per-user, 90s TTL, and already invalidated by every mutation that changes
  collection value (add/sell/update/delete item, want-list, collection CRUD) via
  `invalidateUserCaches(..., ["dashboard"])`. A separate history key would need its own
  invalidation wiring and could drift. This is the trivially-consistent option AGENTS.md
  §(cache optional) and the task's step 4 ask for. Fail-open is inherited from
  `cacheGetJson`/`cacheSetJson`.
- **Range→startDate / timeline / `buildCollectionSeries`**: moved verbatim into the
  service. The pure math in `collection-series.ts` is NOT touched.

## Files touched

- NEW: `src/lib/services/collection-history.service.ts` (server-only extracted logic)
- MODIFY: `src/app/api/users/me/collection/history/route.ts` (thin caller)
- MODIFY: `src/app/(dashboard)/dashboard/page.tsx` (SSR the default histories + extend cache)
- MODIFY: `src/app/(dashboard)/dashboard/_components/DashboardClient.tsx` (new props + conditional `initialData`)
- NEW: `tests/unit/collection-history-service.test.ts` (service shape + SSR-key parity)
- (existing) `tests/integration/history-null-safe.test.ts` must still pass unchanged.

## Ordered implementation items

- [ ] 1. Extract the history-building logic into a server-only service.
      Create `buildCollectionHistories(userId: string, collectionIds: string[], range: string): Promise<Record<string, { date: string; value: number | null }[]>>`.
      Move verbatim from the route: the range→`startDate` mapping, the per-`collId`
      ownership-scoped `prisma.userCollection.findMany` (`"null"`→`collectionId: null`,
      `"all"`→no filter, else `collectionId = collId`), the `HoldingInterval[]` build,
      the `prisma.pricingHistory.findMany` (`priceMarket != null`) + `PricePoint[]`
      build, the daily `timeline`, the `buildCollectionSeries(...)` call, and the
      `{ date: ISO.slice(0,10), value }` map. Do NOT change `collection-series.ts`.
      The function returns the SAME `histories` map the route body built (same keys,
      same empty-array-for-no-lots, same empty-for-`__uncat__` behavior). Keep the
      load-bearing WHY comments. Mark it server-only (imports `@/lib/db`).
      Files: `src/lib/services/collection-history.service.ts`
      Verify: `npm run type-check` passes (new module compiles).

- [ ] 2. Refactor the GET route to a thin caller — same contract, same graceful 200.
      Replace the route body with: parse `collectionIds` (`param ? split(",") : ["null"]`)
      and `range` (default `"1M"`) EXACTLY as today, then
      `const histories = await buildCollectionHistories(userId, collectionIds, range);`
      and `return NextResponse.json({ histories })`. Keep the `try/catch` so any error
      still returns `{ histories: {} }` status 200 (move the try/catch to wrap the
      service call, preserving the existing `console.error` tag). Keep the `requireAuth`
      guard and `guard.unauthorized` early return unchanged.
      Files: `src/app/api/users/me/collection/history/route.ts`
      Verify: `npm run test:integration -- history-null-safe` — both existing
      `collection/history` cases (null-safe values; empty series for no items) pass
      against the mocked Prisma, proving the response shape/behavior is unchanged.

- [ ] 3. SSR the default chart histories in the dashboard page and fold them into the cache.
      In `page.tsx`: after `collOptions`-equivalent info is known, compute the DEFAULT
      selection id list the client uses on first render:
      `const defaultCollectionIds = ["__uncat__", ...collections.map((c) => c.id)];`
      and `const defaultRange = "1M";` and
      `const initialCollectionIdsQuery = defaultCollectionIds.join(",");`.
      Extend `DashboardCache` to `{ rows, collections, histories }`. On a cache MISS,
      ALSO call `buildCollectionHistories(session.user.id, defaultCollectionIds, defaultRange)`
      (add it to the `Promise.all` or run after) and store `{ rows, collections, histories }`
      via `cacheSetJson(cacheKey, ..., CACHE_TTL.dashboard)`. On a cache HIT, read
      `cached.histories` (guard for legacy payloads without the field →
      `cached.histories ?? await buildCollectionHistories(...)` so an old 90s-TTL entry
      can't crash SSR). Pass new props to `DashboardClient`:
      `initialHistories={histories}` `initialRange={defaultRange}`
      `initialCollectionIdsQuery={initialCollectionIdsQuery}`.
      NOTE: do NOT touch the credit gate; `buildCollectionHistories` is Prisma-only,
      zero credits.
      Files: `src/app/(dashboard)/dashboard/page.tsx`
      Verify: `npm run type-check` passes; `npm run build` compiles the dashboard route.

- [ ] 4. Hydrate the chart query with `initialData` ONLY when the live key matches the SSR key.
      In `DashboardClient.tsx`: add props to `DashboardClientProps` and the component
      signature: `initialHistories?: { histories: Record<string, { date: string; value: number | null }[]> } | Record<...>`
      (match the exact shape the route/service returns — i.e. the object the queryFn
      resolves to, `{ histories: {...} }`), `initialRange?: RangeId`,
      `initialCollectionIdsQuery?: string`. On the `["portfolio-history", collectionIdsQuery, activeRange]`
      `useQuery`, add:
      ```ts
      initialData:
        collectionIdsQuery === initialCollectionIdsQuery && activeRange === initialRange
          ? initialHistories
          : undefined,
      ```
      KEEP `placeholderData: (prev) => prev` and `staleTime: 60_000` and the existing
      `queryFn`. Do NOT remove `useDelayedFlag`/`showChartSkeleton` (still covers the
      genuine cold case where SSR produced no match, e.g. user changes range before
      first fetch). Keep the honest "No price history yet" empty state. The queryFn
      resolves to `{ histories }`, so `initialHistories` MUST be that same `{ histories }`
      object (the service returns the inner map, so wrap it as `{ histories }` either in
      the page before passing, or when assigning the prop — pick ONE and keep the shapes
      identical; recommend the page passes `{ histories }` so the prop type mirrors the
      queryFn return).
      Files: `src/app/(dashboard)/dashboard/_components/DashboardClient.tsx`
      Verify: `npm run type-check` + `npm run lint` pass.

- [ ] 5. Add the unit test proving (a) service shape parity and (b) SSR-key parity.
      Create `tests/unit/collection-history-service.test.ts` mocking `@/lib/db` the same
      way `tests/integration/history-null-safe.test.ts` does (`vi.hoisted` prismaMock
      with `userCollection.findMany` + `pricingHistory.findMany`). Assert:
      (a) `buildCollectionHistories(userId, ["null"], "1M")` returns the SAME
          `{ "null": [{date,value}] }` shape the route produced — reuse the integration
          test's fixture (one lot qty 2 added 3d ago, one null + one real `priceMarket:10`
          price) and assert no fabricated `0`, contains `20`, keyed by `"null"`.
      (b) SSR-key parity: given `collections = [{id:"c1"},{id:"c2"}]`, the page's
          `["__uncat__", ...collections.map(c=>c.id)].join(",")` equals
          `"__uncat__,c1,c2"` AND equals `Array.from(new Set(["__uncat__","c1","c2"])).join(",")`
          (the client's `Array.from(activeSelectedIds).join(",")` for the default empty
          selection) — i.e. the SSR query string the page computes is byte-identical to
          the client's first-render `collectionIdsQuery`, with `activeRange === "1M"`.
      Files: `tests/unit/collection-history-service.test.ts`
      Verify: `npm run test:unit -- collection-history-service` passes.

- [ ] 6. Full gate.
      Run the project's verification to confirm nothing regressed (route behavior,
      pure series math, SSR build).
      Files: none
      Verify: `npm run lint` + `npm run type-check` + `npm run test:unit` +
      `npm run test:integration` all pass. (Full `npm run verify` additionally needs a
      reachable `DATABASE_URL` for e2e; run it if the environment allows, otherwise note
      e2e was skipped for lack of DB — the flicker fix is covered by unit+integration+build.)

## Manual confirmation of the fix (what "flicker gone" looks like)

After item 4, on a FIRST dashboard load with the default (All collections, 1M range):
`realHistoriesData` is defined from `initialData` on the very first render →
`historyLoading` is false → `chartLoading` false → `showChartSkeleton` never flips →
the real `MultiLineComparisonChart` (or its honest empty state) is the first thing
painted, with NO grey `<Skeleton>` swap. Changing range/selection still fetches
(matched-key guard returns `undefined`), and `placeholderData` keeps the previous
chart up during that fetch (no skeleton on switches either).

## Assumptions / notes

- Assumed the client's first-render `collectionIdsQuery` is deterministic and equals
  `["__uncat__", ...collectionList].join(",")`. This holds because `collOptions` pushes
  `"__uncat__"` first then iterates `collectionList` in order, and the default empty
  `selectedIds` expands via `new Set(collOptions.map(o => o.id))` preserving that order
  (`Set` + `Array.from` preserve insertion order). Item 5(b) pins this.
- The `__uncat__` vs `null` route mismatch is PRESERVED, not fixed — fixing it is a
  separate behavior change and would desync SSR from the client. Left as-is on purpose.
- Legacy `dashboard:<userId>` cache entries written before this change won't have
  `histories`; item 3's `?? await buildCollectionHistories(...)` fallback handles that
  within the 90s TTL window.
