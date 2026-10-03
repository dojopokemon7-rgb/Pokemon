# Dojo TCG PWA — Performance Findings (evidence-based)

> Investigation only. No product code was changed. All reads/builds done in
> the worktree `.worktrees/perf-optimize` on branch `perf-optimize`
> (HEAD `165a26f`). Production build (`npm run build`) completed successfully;
> the Next.js route table below is captured from that run.

## TL;DR — where the time actually goes

The build output proves the slowness is **not** JS bundle size (shared first-load
JS is a healthy 103 kB; the biggest route, `/search`, is 128 kB first-load). The
real costs are **round-trip latency and redundant/short-cached DB reads on hot
paths**, plus the **user-named "Want to Buy" button** which has **no optimistic
update** — the star only flips after a POST + invalidate + refetch round-trip.

Priority order (impact × how-cheap-the-fix-is):

| # | Finding | Impact | Effort | Risk |
|---|---|---|---|---|
| 1 | "Want to Buy" has no optimistic UI (feels laggy; user-reported) | High | Low | Low |
| 2 | Want-list GET refetched on every star render; no `staleTime`; full-family invalidate forces refetch | High | Low | Low |
| 3 | Trending page-1 fires 4 sequential DB round-trips (groupBy → findMany → count → backfill) | Med | Low | Low |
| 4 | Missing composite index for the `addedAt desc` collection/dashboard ordering (biggest payload query) | Med | Low | Low |
| 5 | Card-detail fires graded grade=10 and grade=9 as two separate requests (double freshness-gate + double HTTP) | Med | Low | Low |
| 6 | `/api/cards/search` sends `Cache-Control: public` but the data is per-user-agnostic yet re-queried per keystroke-settle; no DB-level `name` prefix help for `contains` | Low–Med | Low | Low |
| 7 | Want-list list route re-fetches card display fields on every GET with no cache (fine, but it's on the star hot path via #2) | Low | — | — |

---

## Build evidence (bundle sizes — NOT the bottleneck)

```
Route (app)                                 Size    First Load JS
/dashboard                                9.07 kB      124 kB
/portfolio                                9.66 kB      125 kB
/search                                     13 kB      128 kB
/search/[id]                              9.47 kB      121 kB
/you                                      5.25 kB      127 kB
/scanner                                  3.72 kB      106 kB   (tesseract loads lazily)
+ First Load JS shared by all              103 kB
  chunks/18-….js                          46.4 kB
  chunks/87c73c54-….js                    54.2 kB
Middleware                                34.2 kB
```

Interpretation: no oversized client bundle, no missing code-split worth chasing.
`optimizePackageImports: ["@tanstack/react-query"]` is already set
(`next.config.ts`). **Do not spend effort on bundle splitting** — the evidence
says it won't move the needle. The wins are on the network/DB round-trip side.

---

## Finding 1 — "Want to Buy" button: no optimistic update (USER-REPORTED, HIGHEST)

**Evidence — `src/lib/hooks/useWantToBuy.ts`:**
- The displayed star state comes only from `isWanted(externalId)`, which reads
  `rowByCard` built from the `["want-list","BUY"]` query data.
- `toggle()` calls `add.mutate(...)` / `remove.mutate(...)` and returns a
  *predicted* boolean used only for toast copy. The mutations have **only
  `onSettled: invalidateQueries(["want-list"])`** — no `onMutate`, no
  `setQueryData`. So the star does not change until: POST completes → whole
  `["want-list"]` family invalidated → `["want-list","BUY"]` refetched (another
  GET) → re-render. That is **two sequential network round-trips** before the UI
  reflects the tap.
- Consumers confirmed: `src/app/(dashboard)/search/page.tsx` (`tracked={isWanted(card.externalId)}`, line ~1313 and ~1562) and
  `src/app/(dashboard)/search/[id]/page.tsx` (`const starred = isWanted(id)`, line 541).
- Contrast: `src/components/CardDetailsPopup.tsx` already does it right with a
  local optimistic `useState` that reverts on error (lines 58–75) — proof the
  house pattern exists; the shared hook just doesn't use it.

**Why it's the reported symptom:** on a phone with real latency, the star/label
visibly lags the tap by one-or-two round-trips. This is the "want to buy button
taking too long" the user named.

**Smallest safe fix (AT THE HOOK, per the task):** add the standard TanStack
optimistic pattern to BOTH mutations in `useWantToBuy`:
- `onMutate`: `cancelQueries(["want-list"])`, snapshot the `["want-list","BUY"]`
  cache, then `setQueryData` to add/remove the row immediately (optimistic).
- `onError`: restore the snapshot (revert).
- keep `onSettled: invalidateQueries(["want-list"])` for eventual consistency.

This flips the star on tap with zero behavior change to the API, Zod, ownership
scoping, or the `["want-list"]` family contract. It fixes all three callers at
once (hook-level fix, not per-caller). The F-07 e2e (`e2e/want-list.spec.ts`)
waits for the POST response before asserting and does **not** assert pre-response
timing, so it stays green — no test needs changing first.

---

## Finding 2 — Want-list query is refetched aggressively on the star hot path

**Evidence:**
- `useWantToBuy`'s `useQuery(["want-list","BUY"])` sets **no `staleTime`**, so it
  defaults to the provider's 5 min (`src/app/providers.tsx`) — OK on its own, BUT
- every want-list mutation calls `invalidateQueries({ queryKey: ["want-list"] })`
  (whole family) in `onSettled`. Combined with Finding 1 that means each toggle
  forces a fresh GET `/api/want-list?intent=BUY`.
- Both `search/page.tsx` and `search/[id]/page.tsx` mount `useWantToBuy`
  independently; each mounts its own `["want-list","BUY"]` observer. That's fine
  (shared cache) but amplifies the refetch cost of the family invalidate.

**Impact:** every star tap = 1 POST + 1 GET minimum. With the optimistic fix
(#1) the UI no longer *waits* on these, but the GET is still redundant network
on a hot action.

**Smallest safe fix:** none required beyond #1 for correctness. Optional
micro-win (low priority): once #1 lands, the `onSettled` invalidate becomes a
background reconcile the user never waits on — acceptable as-is. Do **not** drop
the invalidate (it's the eventual-consistency guarantee and keeps the wantlist
page in sync). Leave the family-wide invalidate; it is correct per ARCHITECTURE.md
§7 ("want-list mutations invalidate the whole `["want-list"]`").

---

## Finding 3 — Trending page 1 runs 4 sequential DB round-trips

**Evidence — `src/app/api/cards/trending/route.ts` (sort="trending", offset 0):**
1. `topTrendingCardIds` → `userCollection.groupBy` (await)
2. `card.findMany({ id: { in: rankedIds }})` (await)
3. when ranked < limit: `card.findMany` backfill (await)
4. `card.count({ where: gameFilter })` (await) — for `hasMore`

Steps 2+3 are dependent, but **step 4 (`count`) is independent of 2/3** and runs
strictly after them. On a cold cache (120 s TTL) every first Explore load pays
all four serially. This is the Explore tab's "slow load."

**Smallest safe fix:** run the independent `count` concurrently with the
ranked/backfill fetches via `Promise.all`, i.e. compute `total` in parallel with
the ranked query instead of after it. Keep offset pagination intact (AGENTS.md
rule 12 — do not switch to keyset). Pure reordering of awaits; no behavior change,
no payload change. The 120 s Redis cache already shields repeat loads; this helps
the cold path that users actually feel.

---

## Finding 4 — No composite index backing the `addedAt desc` collection ordering

**Evidence:**
- The two largest-payload queries both order a user's whole collection by
  `addedAt desc`:
  - `src/app/(dashboard)/dashboard/page.tsx` → `userCollection.findMany({ where:{userId}, orderBy:{addedAt:"desc"} })`
  - `src/app/api/users/me/collection/route.ts` GET → same.
- `prisma/schema.prisma` `UserCollection` has `@@index([userId])`, `@@index([cardId])`,
  `@@index([collectionId])` — but **no `([userId, addedAt])`**. Postgres can use
  the `userId` index to filter but must then **sort** the matched rows every time.
  For a large collection (the dashboard SSR is on the critical first-byte path)
  that sort is paid on every dashboard + portfolio + collection GET.

**Smallest safe fix:** add `@@index([userId, addedAt])` to `UserCollection` in
`schema.prisma` and run a migration (`db:migrate` / `db:push`). Index-only
additive change — no query, API, or data-shape change; serves the exact
`where userId + orderBy addedAt desc` the hot reads issue. (This is the same
rationale the schema already documents for `Card.@@index([updatedAt])` serving
trending.) Verify with `EXPLAIN` or simply that the dashboard/collection reads
return correctly after migrate.

---

## Finding 5 — Card detail requests graded prices twice (grade 10 + grade 9)

**Evidence — `src/app/(dashboard)/search/[id]/page.tsx`:**
- Two separate `useQuery`s: `["graded", id, "10"]` → `GET …/graded?grade=10`
  and `["graded", id, "9"]` → `GET …/graded?grade=9`. The grade=9 result is used
  only for the "PSA 9" chip label.
- Server route `src/app/api/cards/[id]/graded/route.ts` runs
  `pullAndStoreScrydexPrice` (freshness-gated to 24 h via `SyncLog`) then
  `pickGradedPrice`. The freshness gate means the *second* call usually does no
  HTTP/credit — but it is still a **second full HTTP round-trip + DB read + gate
  check** on every card-detail open, and both run on the detail page's initial
  fan-out.

**Smallest safe fix (no new credit spend — AGENTS.md credit-gate rule):** the two
grades share the same underlying ScrydexCard. Options, cheapest first:
- (a) Have the client fire the two as they are but confirm they're parallel (they
  already are via independent `useQuery` — so this is only a redundant HTTP, not a
  waterfall). Lowest-risk improvement: give both `staleTime` already set (60 s) —
  acceptable. **If** reducing to one round-trip is wanted, extend the graded route
  to accept `grades=9,10` (comma list) and return a map `{ "9": …, "10": … }`,
  computed from the single `pullAndStoreScrydexPrice` result + `pickGradedPrice`
  per grade. One pull, one HTTP, same gate, **zero new live credit calls** (the
  pull is identical to today's first call). Update the detail page to one
  `["graded", id, "9,10"]` query.
- This stays within the credit gate (the single pull is already gated and is the
  same spend as the current first request; the second request is eliminated, not
  added). No Zod/ownership/degradation contract change — the route still returns
  200 with `{price:null}` on unknown/unpriced.

**Rating note:** medium impact because it halves the detail page's graded network
and removes a duplicate gate/DB check; low effort; low risk. Marked optional vs
required in the plan.

---

## Finding 6 — Search route cache + `contains` scan (minor)

**Evidence — `src/app/api/cards/search/route.ts`:**
- Query match is an `OR` of `name contains`, `number contains`,
  `tags has q`, `set.name contains`, `set.externalId contains`. `tags has` is
  GIN-indexed (`Card.@@index([tags], type: Gin)`), but the `name contains`
  (substring, case-insensitive) is a sequential scan on `card.name` for the
  non-tag path. For the seeded catalog (~70+ cards, docs say) this is negligible
  today; it only matters if the catalog grows large.
- Response sets `Cache-Control: public, max-age=30, swr=300` which is correct and
  already buffers repeated keystrokes.

**Smallest safe fix:** **none now** — not worth a trigram/pg_trgm index at current
catalog size and it would add migration surface. Documented as a watch-item: if
the catalog grows into the thousands, add a `pg_trgm` GIN index on
`lower(name)` to make `contains` indexable. Explicitly out of scope for this pass
(YAGNI).

---

## Non-issues confirmed (so the implementer doesn't "fix" them)

- **Bundle size / code-splitting**: healthy (see build table). Leave it.
- **Collection GET / dashboard SSR `select`**: already narrowed to the exact
  columns the UI reads (dead-payload comment in the route) — good, don't touch.
- **Trending `select`**: already a narrow `TRENDING_SELECT` projection — good.
- **Reprice route**: already `Promise.all` over ids, off the hot path, 6 h
  Redis-cached, DB backfill best-effort — good.
- **DashboardClient stats**: already `useMemo`-wrapped over a bounded collection —
  no render-cost fix needed.
- **Redis coverage**: trending 120 s, search 30 s HTTP, ebay-sold 24 h, graded
  freshness-gated 24 h — coverage is appropriate; do NOT add caching that would
  make a cache failure fail a request (AGENTS.md rule 1).
- **eBay-sold / graded live credit**: credit-gated; the plan introduces **no new
  live credit-consuming Scrydex call** (Finding 5 reuses the single existing pull).

---

## Invariants honored by every recommendation

- Redis stays cache-only / optional (no change to the try/catch fall-through).
- No fabricated data; null still renders "—".
- `Card.id` vs `Card.externalId` untouched (want-list keys on externalId as today).
- Zod boundaries unchanged.
- Ownership `where:{id,userId}` scoping unchanged.
- Offset pagination preserved (Finding 3 only parallelizes awaits).
- Scrydex credit gate not bypassed; no new live credit calls (Finding 5).
- Load-bearing comments/doc-chains preserved.
