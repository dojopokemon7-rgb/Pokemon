# Implementation Plan — Safe & atomic collection delete (audit 05 F-01 / 01 P-05, HIGH)

## Context & design decisions (grounded in the worktree)

**The bug.** `DELETE /api/collections/[id]` → `deleteCollection(userId, id)` in
`src/lib/services/collection.service.ts` calls a bare `prisma.collection.delete`.
The FK `UserCollection.collectionId` is `onDelete: SetNull`
(`prisma/schema.prisma` line 334), so deleting a collection nulls its active lots'
`collectionId`. The partial unique index `uc_variant_coalesced` is
`UNIQUE(userId, COALESCE(collectionId,''), cardId, isFoil, COALESCE(condition,'')) WHERE isSold=false`
— NULL `collectionId` coalesces to `''`. If the user already holds a NULL-scoped
(uncategorized) active lot of the same `(cardId, isFoil, condition)`, the SetNull
collides → Postgres unique violation (P2002). The DELETE route only maps P2025
(not-found) → 404; a P2002 falls through the `throw err` → uncaught 500, and the UI
silently keeps the collection.

**The fix (chosen approach — MERGE, not just catch).** Replace the bare delete with
a `$transaction` that re-homes active lots to the NULL/uncategorized scope by
MERGING into any colliding NULL-scoped active lot, THEN deletes the Collection — all
atomic. This mirrors the sell-revert merge-back shipped in commit `8bafcf8`
(`src/app/api/users/me/collection/[id]/route.ts`, the `isSold === false` branch):
look up the active sibling, bump its quantity, delete the duplicate, all in one
`$transaction`. Chosen over the fallback (catch P2002 → 409) because a 409 still
BLOCKS a legitimate delete, leaving the user stuck. The 409 catch is kept only as a
belt-and-suspenders guard for a concurrent race (same pattern as commit `8bafcf8`).

**Merge key must match the DB index semantics.** The add route
(`src/app/api/users/me/collection/route.ts` ~line 434) and the sell-revert fix both
normalize condition as `norm(c) = (c ?? "").trim().toUpperCase()` and match on
`(userId, cardId, isFoil, condition, isSold:false)` within a fixed `collectionId`
scope. The merge here matches the SAME tuple but with the TARGET scope fixed to
`collectionId: null`. `norm` collapses `null`/`""`/whitespace to `""`, mirroring the
index's `COALESCE(condition,'')`. Reuse this exact `norm` so the app-side merge key
and the DB index agree. (`condition` holds either a raw string or a graded label
like `"PSA 10"`; exact-normalized compare keeps raw-vs-graded as distinct lots,
consistent with the add path.)

**Sold lots are untouched.** The index is partial (`WHERE isSold=false`), so sold
rows never collide. SetNull on a sold row is harmless. The merge only scans/moves
`isSold:false` lots; sold rows are left to SetNull naturally (collectionId nulled,
no uniqueness interaction).

**WantListItem (audit 01 P-05).** `WantListItem.collectionId` is also
`onDelete: SetNull` (`prisma/schema.prisma` line 586) under `wli_scope_coalesced`
`UNIQUE(userId, COALESCE(collectionId,''), cardId, intent)` — the SAME latent
collision. The collection-delete path IS reachable to want rows: deleting a
collection SetNulls its want items to account-level, so a user who holds an
account-level (null-scoped) want row of the same `(cardId, intent)` AND a
collection-scoped one hits the same P2002. Therefore fix it too, in the SAME
transaction: for each want row in the deleted collection, if a null-scoped row with
the same `(userId, cardId, intent)` already exists, DELETE the duplicate (a want row
has no quantity — a collision just means drop it); otherwise SetNull it (set
`collectionId = null`). Do the want-row remediation inside the same `$transaction`
as the lot merge and the collection delete so the whole operation is atomic.

**Cache invalidation (audit 05 F-09 / caching 12 F6).** The DELETE route ALREADY
invalidates `["collections", "dashboard"]` after a successful delete
(`invalidateUserCaches(userId, ["collections", "dashboard"])`). Because lots and
want rows now move to the uncategorized/account scope, the `collection` and
`wantlist` scopes also go stale. Extend the existing call to
`["collections", "dashboard", "collection", "wantlist"]` — a one-line, safe addition
using the existing `CacheScope` union (all four scopes already exist in
`src/lib/utils/cache.ts`). No client-side TanStack change is planned: the client
refetch on delete is out of scope and would be scope-creep; noted here for the
reviewer.

**Constraints honored.** Ownership scoping (`where: { id, userId }`) and the existing
P2025→404 mapping are preserved. No change to `prisma/schema.prisma` or
`src/lib/auth.ts` (held-back H-2). RULE 2 (no fabrication) — quantities are conserved
on merge, nothing invented. No push/deploy/merge.

**Transaction shape decision.** Use the interactive `$transaction(async (tx) => …)`
callback form (not the array form), because the merge needs to READ (find colliding
null-scoped siblings) and conditionally WRITE within the same transaction — the array
form can't branch on reads. The service's `deleteCollection` keeps its existing
pre-checks (`assertNotVirtual`, `assertNotMain`) OUTSIDE/BEFORE the transaction
(they already run before any write today).

---

## Plan

- [ ] 1. Rewrite `deleteCollection` in the service to merge-then-delete atomically.
      In `src/lib/services/collection.service.ts`, replace the body of
      `deleteCollection(userId, collectionId)` (currently a bare
      `prisma.collection.delete`). Keep the leading `assertNotVirtual(collectionId)`
      and `await assertNotMain(userId, collectionId)` guards. Then run one
      `prisma.$transaction(async (tx) => { … })` that, scoped to `{ userId }`:
      (a) loads the collection's ACTIVE lots
      (`tx.userCollection.findMany({ where: { collectionId, userId, isSold: false } })`);
      (b) loads the user's existing NULL-scoped active lots once
      (`tx.userCollection.findMany({ where: { userId, collectionId: null, isSold: false } })`)
      and indexes them by the key `cardId|isFoil|norm(condition)` where
      `norm = (c) => (c ?? "").trim().toUpperCase()` (copy the helper used in the add
      route / commit 8bafcf8); (c) for each collection lot: if a null-scoped sibling
      with the same key exists, `tx.userCollection.update` the sibling
      `quantity: sibling.quantity + lot.quantity` and `tx.userCollection.delete` the
      lot, updating the in-memory index so two collection lots that share a key both
      fold into the same sibling; else `tx.userCollection.update` the lot to
      `collectionId: null` (and add it to the index so a later same-key lot merges
      into it); (d) handle WantListItem the same way: load
      `tx.wantListItem.findMany({ where: { collectionId, userId } })` and the user's
      null-scoped want rows keyed by `cardId|intent`; for each, if a null-scoped
      sibling exists `tx.wantListItem.delete` the duplicate, else
      `tx.wantListItem.update` it to `collectionId: null`; (e) finally
      `tx.collection.delete({ where: { id: collectionId, userId } })` and return its
      result (preserves the existing return shape used by the route's
      `{ data: { id } }`). Sold lots are deliberately not touched (the index is
      partial on `isSold=false`). Keep the existing doc-comment and extend it to
      explain the merge (RULE 14 — comments are load-bearing).
      Files: `src/lib/services/collection.service.ts`
      Verify: `npm run type-check` passes (no new errors outside the pre-existing
      `src/lib/auth.ts` ones); `npm run test:integration -- collections` — existing
      `deleteCollection` test (`deletes a collection the user owns`) still passes
      (it mocks `prisma.collection.delete` + now `$transaction`/`userCollection`/
      `wantListItem` — see item 3).

- [ ] 2. Map a concurrent P2002 to 409 in the DELETE route (belt-and-suspenders).
      In `src/app/api/collections/[id]/route.ts`, in the `DELETE` handler's `catch`,
      before the final `throw err`, add: if
      `err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"`,
      return a 409 `{ error: "Conflict", message: "Couldn’t delete this collection because one of its cards conflicts with an existing uncategorized copy. Please try again." }`
      (mirrors the 409 mapping already present in the PATCH handler and in commit
      8bafcf8). Keep the existing `VirtualCollectionReadonlyError`,
      `MainCollectionProtectedError`, and P2025→404 branches, and the already-present
      `invalidateUserCaches(...)` call (item 4 extends its scopes). This is the
      fallback guard for a race where a null-scoped sibling is created between the
      transaction's read and the delete commit; the merge in item 1 handles the
      common case so a legitimate delete is no longer blocked.
      Files: `src/app/api/collections/[id]/route.ts`
      Verify: `npm run type-check` passes; covered by the route-level test in item 3.

- [ ] 3. Add an integration test reproducing the collision + happy path.
      Create `tests/integration/collection-delete.test.ts` following the mocked-Prisma
      harness in `tests/integration/collection-revert.test.ts` and
      `tests/integration/collections.test.ts` (hoisted `prismaMock` with
      `collection.{findFirst,delete}`, `userCollection.{findMany,update,delete}`,
      `wantListItem.{findMany,update,delete}`, and `$transaction`; mock
      `@/lib/db`, `@/lib/utils/auth-guard` → session `user_123`, and
      `@/lib/utils/cache`). Make `$transaction.mockImplementation(async (cb) => cb(prismaMock))`
      (interactive-callback form — the service now uses the callback form, so the mock
      must invoke the callback with the mock client; see collection-revert's
      beforeEach for the pattern, adapted to callback form). Import the DELETE route
      handler from `@/app/api/collections/[id]/route`. Cover:
      (1) **collision merges, no 500** — `collection.findFirst` (for `assertNotMain`)
      returns a non-Main collection; the collection's active `userCollection.findMany`
      returns one lot of card X in collection A; the null-scoped `findMany` returns an
      existing null-scoped active lot of the SAME `(cardId, isFoil, condition)`; want
      `findMany`s return empty; assert status 200, `userCollection.update` called with
      the sibling's id and merged `quantity`, `userCollection.delete` called for the
      collection lot, and `collection.delete` called with
      `where: { id, userId }`;
      (2) **happy path, no colliding lots** — collection lot exists, null-scoped
      `findMany` returns `[]`; assert 200, the lot is `update`d to
      `collectionId: null` (not deleted), `collection.delete` called, and the response
      body is `{ data: { id } }` (existing success shape);
      (3) **want-row collision** — a collection want row collides with an existing
      null-scoped want row of the same `(cardId, intent)`; assert `wantListItem.delete`
      called for the duplicate and no P2002 surfaces (status 200);
      (4) **concurrent P2002 → 409** — make `collection.delete` reject with a
      `Prisma.PrismaClientKnownRequestError` `{ code: "P2002" }`; assert the route
      returns 409, not 500;
      (5) **foreign/nonexistent id → 404** — `collection.delete` rejects with P2025;
      assert 404 (regression guard on the preserved mapping).
      Files: `tests/integration/collection-delete.test.ts`
      Verify: `npm run test:integration -- collection-delete` — all new cases pass.

- [ ] 4. Extend post-delete cache invalidation to the moved scopes.
      In `src/app/api/collections/[id]/route.ts`, change the DELETE handler's
      `invalidateUserCaches(userId, ["collections", "dashboard"])` to
      `invalidateUserCaches(userId, ["collections", "dashboard", "collection", "wantlist"])`
      (all four are existing members of `CacheScope` in `src/lib/utils/cache.ts`), so
      the uncategorized collection view and the account-level want list refetch after
      lots/want rows move. Best-effort and after-commit — a Redis fault still can't
      fail the delete (RULE 1). Do NOT add any client/TanStack changes (out of scope).
      Files: `src/app/api/collections/[id]/route.ts`
      Verify: `npm run type-check` passes (type-checks the `CacheScope[]` arg);
      `npm run lint` passes.

- [ ] 5. Full gate + doc touch.
      Run the matching test scopes and static checks for the layers touched (service,
      route, tests). If `docs/API_REFERENCE.md` or `docs/ARCHITECTURE.md` documents the
      `DELETE /api/collections/[id]` contract or the SetNull-on-delete behavior, add a
      one-line note that delete now merges active lots + want rows into the
      uncategorized/account scope atomically and may return 409 on a concurrent
      conflict (AGENTS.md: update docs in the same change when routes/services change).
      Files: `docs/API_REFERENCE.md` and/or `docs/ARCHITECTURE.md` (only if they cover
      this route)
      Verify: `npm run lint` && `npm run type-check` &&
      `npm run test:integration -- collection` all pass (the `collection*` integration
      suite, which includes the new delete test and the existing collections/revert
      suites). `npm run test:unit` if any unit file is affected (none expected). Note
      for the reviewer: full `npm run verify` additionally runs e2e against a live
      remote `DATABASE_URL` + production build, which may be unavailable in this
      worktree; if so, state that e2e was not run and why.

## Notes / assumptions for the reviewer

- The want-list path IS reachable on collection delete (SetNull on
  `WantListItem.collectionId`), so it is fixed in the same transaction. Want rows have
  no quantity, so a collision is resolved by deleting the duplicate, not merging.
- Sold lots are intentionally excluded from the merge: `uc_variant_coalesced` is
  partial on `isSold=false`, so sold rows can never trip it; they SetNull harmlessly.
- The 409 catch (item 2) is a race-only fallback; the merge (item 1) is the primary
  fix so legitimate deletes are never blocked.
- No schema change: the `onDelete: SetNull` FK and the expression indexes stay as-is;
  the application now remediates the collision before the FK fires. `prisma/schema.prisma`
  and `src/lib/auth.ts` are untouched per the held-back-H-2 constraint.
- Client-side TanStack query invalidation on delete is deliberately out of scope
  (server-cache invalidation is extended; client refetch would be scope-creep).
