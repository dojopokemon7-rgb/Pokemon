# Dojo performance pass — optimistic Want to Buy, trending count parallelism, collection index

Three evidence-backed, server/DB/cache-timing changes plus a pinning test and in-commit doc sync. The user-reported "Want to Buy taking too long" symptom is fixed at the shared hook (`useWantToBuy`) by adding the standard TanStack optimistic pattern to both mutations, so the star flips on tap instead of after a POST + family-invalidate + refetch (two sequential round-trips). A composite `@@index([userId, addedAt])` backs the hot `where userId + orderBy addedAt desc` collection/dashboard reads, and the trending page-1 `count` is kicked off concurrently with the ranked chain to drop one serial round-trip on the cold Explore load. The optional graded-request collapse (plan step 4) was deliberately skipped with a sound rationale (already parallel, freshness-gated, would churn the route contract and e2e mocks for a micro-win).

Watch for: the trending `count` reorder is a pure await-reorder on an immutable `gameFilter` — identical result set, cursor math, Redis cache, and offset pagination (confirmed). The optimistic synthetic row keys on `cardId: externalId`, matching the real refetched shape, so `isWanted` stays stable across the optimistic→refetch swap (confirmed). One e2e spec (`portfolio-real-chart.spec.ts`) fails, argued pre-existing and unrelated; the diff touches none of the portfolio/dashboard-chart/collection-selection/add paths, so the claim holds (likely).

**Verdict**: APPROVED

## High-level view

The Want to Buy fix lives entirely in `src/lib/hooks/useWantToBuy.ts`, exactly where the task asked. Both `add` and `remove` gain `onMutate` (cancel the `["want-list"]` family, snapshot `["want-list","BUY"]`, optimistically write) and `onError` (restore the snapshot), while `onSettled` keeps the whole-family invalidate — the eventual-consistency contract from ARCHITECTURE.md §7 is preserved, not weakened. Because `isWanted` derives from the `["want-list","BUY"]` cache, writing that cache in `onMutate` is what makes the star flip before the network settles. All three callers (two search tiles + detail page) inherit the fix for free; no caller changed.

The composite index is additive only. The two largest-payload reads — dashboard SSR and `GET /api/users/me/collection` — both issue `where userId` + `orderBy addedAt desc`, and `UserCollection` previously had only `@@index([userId])`, forcing a per-request sort of matched rows. The new `@@index([userId, addedAt])` serves the sort index-ordered. No query, API, or result-shape change; `db:push` applied it per the verification note.

The trending change moves `prisma.card.count({ where: gameFilter })` to fire before the ranked/backfill chain is awaited, then awaits it only when computing `hasMore`. `gameFilter` is computed once and never mutated, the count is independent of the ranked reads, and offset pagination (AGENTS.md rule 12) is untouched — this is the forbidden-keyset-rewrite's opposite: a safe reorder.

Verification evidence is present and credible: lint, type-check, unit (17 files/101 tests, +1 file for the new optimistic test), integration (12/92), chart-accuracy (60/60 within ±10%), and build all pass; e2e is 39/1 with the one failure analyzed as unrelated. Per instructions I did not re-run these suites.

<details>
<summary>Issues (1)</summary>

1. **Unrelated e2e failure (non-blocking)** — `portfolio-real-chart.spec.ts` fails, attributed to pre-existing collection-selection behavior. The diff touches none of the portfolio/dashboard-chart/collection-selection/add paths, so it does not block this pass, but it should be tracked separately so the gate isn't permanently red.

</details>

<details>
<summary>Details</summary>

### Want to Buy: genuinely optimistic, fixed at the hook, family invalidate intact

The task's three acceptance points are all met. The fix is in `src/lib/hooks/useWantToBuy.ts` (the shared hook), not duplicated per caller — `search/page.tsx` ×2 and `search/[id]/page.tsx` consume the unchanged `isWanted`/`toggle` surface and benefit automatically. The update is UI-before-network: `onMutate` writes `["want-list","BUY"]` synchronously (after `cancelQueries` to prevent an in-flight GET clobbering the optimistic write), and `isWanted` reads exactly that cache via `rowByCard`, so the star reflects the tap immediately. `onSettled` still calls `invalidateQueries({ queryKey: ["want-list"] })` on both mutations — the whole-family invalidate the plan and ARCHITECTURE.md §7 require is preserved.

The add path inserts a synthetic row `{ id: "optimistic-"+externalId, cardId: externalId, intent: "BUY" }`. The `cardId: externalId` keying matters: `want-list.service.ts` resolves display fields by `externalId` and `WantListItem.cardId` holds the external id, so the synthetic row's shape matches the refetched row and `isWanted` does not flicker when `onSettled` swaps the optimistic id for the real one. The add path is also idempotent-safe — if the card is already present it returns the existing cache rather than duplicating. The two card ids are not confused (AGENTS.md rule 3 honored).

### Trending count parallelism — a reorder, not a pagination rewrite

`const totalPromise = prisma.card.count({ where: gameFilter })` is issued before `await topTrendingCardIds(...)`, and `const total = await totalPromise` replaces the former inline `await` at the `hasMore` computation. `gameFilter` is defined once at the top of the try block and never reassigned, so hoisting the count cannot change what it counts. The ranked fetch, backfill, `rankIndex` reordering, `rows` assembly, `nextCursor` math, the `TRENDING_SELECT` projection, and the 120s fail-open Redis cache are all byte-identical. Offset pagination (rule 12) is intact. The count still runs inside the same outer try/catch, so a DB error propagates exactly as before.

### Composite index — additive, serves a real query

`@@index([userId, addedAt])` on `UserCollection` targets the confirmed `where: { userId }` + `orderBy: { addedAt: "desc" }` in both `dashboard/page.tsx` and `api/users/me/collection/route.ts` GET. The load-bearing comment explains the rationale and ties it to the existing `Card.@@index([updatedAt])` precedent — comment discipline (rule 14) respected. No existing index removed; the F-15 bulk `addedAt` stamping ordering is unaffected (the index speeds the same sort it already relied on).

### Invariants spot-checked, all preserved

Redis paths in the trending route keep their try/catch fall-through (rule 1); no fabricated data introduced (rule 2); Zod boundaries in the want-list route unchanged (rule 4); ownership `where:{id,userId}` scoping untouched (rule 5); no server-only secret or Vision key moved toward the client — the hook is already `"use client"` and only calls same-origin fetch (rule 6); the want-list GET still degrades to `{ data: [] }` on error rather than 5xx (rule 7); no Scrydex credit-consuming call added or the credit gate bypassed — the skipped graded-collapse was the only change that would have touched that path, and it was deliberately not implemented (credit-gate rule); One Piece image proxy untouched; load-bearing comments preserved and extended.

### Tests and docs

The behavior change is TDD-pinned: `tests/unit/use-want-to-buy.test.tsx` (new) holds the POST in flight via a hand-resolved deferred and asserts `isWanted` is true while pending (fails if the mutations regress to plain `onSettled`), and asserts revert on a 500 (fails if `onError` is dropped). This is the right single runnable check for the optimistic logic. Docs are updated in the same commit: `docs/ARCHITECTURE.md` adds the new index to "Indexes worth knowing," and `docs/PERFORMANCE.md` records all three changes under a "perf-optimize pass" section. The file set is clean — only the three code files, the test, two docs, and the task artifacts; no unrelated bundling and no new dependencies.

### E2E failure (not caused by this work)

`portfolio-real-chart.spec.ts` times out waiting for the portfolio comparison chart. The verification note attributes it to the probe card landing in the default/uncategorized set so the selected "Main" collection renders the empty state. The changed files touch none of the portfolio page, dashboard chart, collection selection, or add route, which makes the pre-existing attribution credible. Not blocking, but it should be tracked so the gate isn't left permanently red.

</details>

<details>
<summary>File map</summary>

- `src/lib/hooks/useWantToBuy.ts` — added `onMutate`/`onError` optimistic cache writes to both add and remove mutations; `onSettled` family invalidate kept.
- `prisma/schema.prisma` — added `@@index([userId, addedAt])` to `UserCollection` with a load-bearing comment.
- `src/app/api/cards/trending/route.ts` — page-1 `count` kicked off concurrently with the ranked chain, awaited only at `hasMore`.
- `tests/unit/use-want-to-buy.test.tsx` — new; pins optimistic flip-while-pending and revert-on-500.
- `docs/ARCHITECTURE.md`, `docs/PERFORMANCE.md` — index entry + perf-pass notes, same commit.
- `.agents/tasks/{perf-findings,plan,verification}.md` — process artifacts.

Full diff: `git -C "d:\Work Code\Projects\pokemon TCG\app\Pokemon\.worktrees\perf-optimize" diff master...perf-optimize`

</details>
