# Implementation Plan — Per-Collection 5-Bucket Collection Model (Feature #8)

> **Source of truth:** `collection-buckets-design.md` (revision 3, APPROVED) +
> `collection-buckets-requirements.md` (owner-locked). This plan sequences that design as a
> strict TDD (RED → GREEN) build. Do NOT re-decide architecture — the design fixes the
> mechanism; this plan fixes the order.

## ENV / guardrails (read before step 1 — applies to EVERY step)

- **Worktree:** all work happens in `d:\Pokemon\.worktrees\feat-collection-buckets-v2`. Run every
  command from that directory (quote paths — the parent repo path contains a space). Relative
  paths resolve here, not in `d:\Pokemon`.
- **LOCAL DB ONLY — never remote Supabase.** For every command that touches the DB (migrate,
  type-check after generate, build, tests), export these first (PowerShell per-command):
  `$env:DATABASE_URL="postgresql://dojo:dojo@localhost:5433/dojo"; $env:DIRECT_URL="postgresql://dojo:dojo@localhost:5433/dojo"; $env:REDIS_URL="redis://localhost:6380"`.
  Do NOT point `prisma migrate dev` at Supabase. (The design text mentions Supabase `directUrl`;
  that is overridden here — the migration runs against the LOCAL dev DB on port 5433.)
- **ZERO Scrydex credits.** Make NO external/Scrydex calls. The credit gate
  (`src/lib/services/scrydex-credit-gate.ts`), `SCRYDEX_LIVE_CREDITS_APPROVED`, and the
  `scrydex:credit-approval` Redis flag stay at default DENY and are NOT touched. All price/value
  reads use already-stored columns only.
- **Record verification output.** The implementer MUST record every command run and its result
  (pass/fail + key output lines) in the "Verification log" section at the bottom of THIS plan
  file (or in the commit message) so the reviewer can read the evidence. Append, don't overwrite.
- **AGENTS.md invariants preserved throughout:** Card.id vs externalId vs scrydexId discipline
  (rule 3); ownership `where:{…,userId}` → P2025→404 (rule 5); `assignBulkAddOrder`
  strictly-decreasing `addedAt` (rule 9); offset pagination untouched (rule 12); design tokens
  `--color-dojo-*`, square corners, hard-offset shadows, canonical `ArrowRight` CTA (rule 10);
  load-bearing comments preserved (rule 14); pure utils client-safe, no server imports (rules 6,
  11).

## TDD discipline

Steps 1–6 are the RED phase: change pinned tests and add new test files FIRST so they encode the
new behavior and FAIL against current code. Steps 7–15 are the GREEN phase: schema/migration,
utils, services, routes, UI, docs. Step 16 is full verification. Each step says how to confirm it
did what it should (a RED step is "verified" when the named tests fail for the EXPECTED reason —
missing export / wrong shape — not a syntax error).

Run tests with the LOCAL DB env exported. Unit/integration tests use mocked Prisma / pure inputs
(no live DB), but still export the env so nothing accidentally reaches Supabase.

---

## RED phase — change pinned tests + add new test files FIRST

- [ ] 1. **Change F-10 integration test to encode the new per-collection + constraint behavior.**
      Extend `tests/integration/collections.test.ts` with cases that import and exercise the NEW
      service `listCollectionsWithBuckets` (mock `prisma.userCollection.groupBy` and
      `prisma.wantListItem.groupBy`): per-collection bucket counts with `main`/`all`/`sold` =
      summed `_sum.quantity` and `buy`/`sell` = `_count._all`; a loose `__uncat__`
      pseudo-collection; degradation returns ZEROED buckets `{main:0,all:0,buy:0,sell:0,sold:0}`
      (never omitted) when a `groupBy` throws. Add a mocked `prisma.userCollection` surface
      (`findFirst`, `findMany`, `create`, `update`) and import the route handlers from
      `src/app/api/users/me/collection/route.ts` and `.../[id]/route.ts`. Cases: (a) exact-condition
      dedupe — adding raw `null` then raw `"NM"` of the same card to the same collection yields TWO
      rows; adding the same raw `null` twice increments ONE row; raw vs `"PSA 10"` stays TWO rows;
      (b) P2002 race on `uc_variant_coalesced` — mock `create` to throw
      `new Prisma.PrismaClientKnownRequestError("…",{code:"P2002",clientVersion:"6"})` once, assert
      the POST re-reads and increments the existing lot and records `ok:true` (NOT a failed card /
      500); (c) **PATCH `.../collection/[id]` re-file 409** — mock `update` to throw
      `PrismaClientKnownRequestError{code:"P2002", meta:{target:["uc_variant_coalesced"]}}`, assert
      the route returns 409 "That variant is already in the target collection" (not a raw 500); (d)
      **PATCH cross-user 404** — mock `prisma.collection.findFirst` → null for a foreign
      `collectionId`, assert 404. Thread `collectionId` through the want-list create/move cases if
      present. Keep the existing CRUD/validator cases.
      Files: `tests/integration/collections.test.ts`
      Verify: with LOCAL DB env exported, `npx vitest run tests/integration/collections.test.ts` —
      the NEW cases FAIL (missing `listCollectionsWithBuckets` export / un-wrapped 500 / no P2002
      handling). Existing CRUD cases still pass. Record the failing case names.

- [ ] 2. **Change F-11 aggregation test to pin the dual-All contract.**
      In `tests/unit/collection-aggregation.test.ts` add cases (the aggregator math is UNCHANGED,
      so these import the new `collection-scope` helpers alongside the aggregator): assert that
      `activeWhere(userId, toScope("<id>"))` and the in-collection "Main" resolve to the IDENTICAL
      `where` (`{userId, collectionId:"<id>", isSold:false}`), and that top-level All
      (`aggregateCollectionStats(items, ALL_COLLECTIONS)`) still sums across `collectionId:null`
      rows. Keep all existing math cases.
      Files: `tests/unit/collection-aggregation.test.ts`
      Verify: `npx vitest run tests/unit/collection-aggregation.test.ts` — the new scope-import
      cases FAIL (`@/lib/utils/collection-scope` does not exist yet); existing math passes.

- [ ] 3. **Change F-22 compare test with the null-row regression case.**
      In `tests/integration/compare-collections.test.ts` ADD one case asserting a per-collection
      comparison still ignores `collectionId:null` rows now that want-scoping exists (the
      `compare-collections.ts` logic is unchanged — this is a regression pin). Keep existing cases.
      Files: `tests/integration/compare-collections.test.ts`
      Verify: `npx vitest run tests/integration/compare-collections.test.ts` — all cases currently
      PASS (logic unchanged); the added case documents intent. (This file stays green; it is a
      pin, not a RED driver. Note that in the log.)

- [ ] 4. **Change the series test to feed `collectionId:"null"` for the loose-sold case.**
      In `tests/unit/collection-series.test.ts` add TWO cases: (a) a named-collection sold lot's
      interval `[addedAt, soldAt)` ends in the SAME collection's series (collectionId preserved);
      (b) a loose sold lot fed as `collectionId:"null"` (the STRING sentinel the real
      `history/route.ts` caller produces — NOT raw `null`, NOT `"__uncat__"`), asserting its
      interval lands in the `"null"` series. Do NOT change `collection-series.ts`'s `string` type.
      Files: `tests/unit/collection-series.test.ts`
      Verify: `npx vitest run tests/unit/collection-series.test.ts` — all cases PASS against the
      UNCHANGED util (the util already groups by the string `collectionId`); these cases pin FR-5.2
      at the series layer. Confirm case (b) uses `"null"`, never `"__uncat__"`.

- [ ] 5. **Add the three new RED test files (pure/scope + want-list scoping).**
      Create: `tests/unit/collection-scope.test.ts` — `toScope`/`activeWhere`/`soldWhere`: all THREE
      all-signals collapse to `{kind:"all"}` (`null`/`""`, `ALL_VIEW_ID "__all__"`,
      `ALL_COLLECTIONS "all"`); `"__uncat__"`→`{kind:"loose"}`; any other id→`{kind:"collection"}`;
      exact `where` fragments incl. `collectionId:null` for loose and no `collectionId` key for all.
      Create: `tests/unit/collection-buckets.test.ts` — the pure `selectBuckets`: Main==All within a
      collection (same array); Buy/Sell scoped by `collectionId`; Sold filtered per collection; for
      `{kind:"all"}` → `main=[]` and `sold=[]` while `all`=the full union incl. `null`; TRADE
      excluded; empty buckets → empty arrays. (This is the ONE runnable check the bucket logic must
      leave behind.)
      Create: `tests/integration/want-list-scoping.test.ts` — mocked Prisma service tests:
      `addWantListItem` idempotent find-or-create at BOTH null (account, `findFirst` with
      `collectionId:null`) and non-null scopes (existing → no second `create`); a mocked concurrent
      P2002 on `wli_scope_coalesced` maps to idempotent success (NOT 409); `listWantList` filters by
      `collectionId` (null = account, omission = all scopes, non-null = that collection);
      `moveWantListItem` collision → P2002 (→409 at route); ownership P2025→404.
      Files: `tests/unit/collection-scope.test.ts`, `tests/unit/collection-buckets.test.ts`,
      `tests/integration/want-list-scoping.test.ts`
      Verify: `npx vitest run tests/unit/collection-scope.test.ts tests/unit/collection-buckets.test.ts tests/integration/want-list-scoping.test.ts`
      — all FAIL (modules `@/lib/utils/collection-scope`, `@/lib/utils/collection-buckets`, and the
      new service signatures don't exist yet). Record the failures.

- [ ] 6. **Add the integration scope test file (collection-scope end-to-end wiring).**
      Create `tests/integration/collection-scope.test.ts` — mocked-Prisma tests that the server read
      paths consume the scope helpers correctly: the want-list GET route maps `?collectionId=<id>` /
      `?collectionId=__account__` / absent into the right `listWantList` options (via `toScope`
      semantics), and the collection-detail read path scopes its fetch with `activeWhere`/`soldWhere`.
      Mock `requireAuth` and the service calls; assert the `where`/options passed.
      Files: `tests/integration/collection-scope.test.ts`
      Verify: `npx vitest run tests/integration/collection-scope.test.ts` — FAILS (helpers + the new
      route wiring don't exist yet). Record the failure.

---

## GREEN phase — schema, migration, utils, services, routes, UI, docs

- [ ] 7. **Prisma schema diff (design §2) — NO Prisma `@@unique` on the new keys.**
      In `prisma/schema.prisma`: on `WantListItem` add `collectionId String?` + the
      `collection Collection? @relation(fields:[collectionId], references:[id], onDelete:SetNull)`,
      DELETE the `@@unique([userId, cardId, intent])` line (replaced by the expression index in the
      migration), KEEP `@@index([userId, intent])`, and ADD `@@index([userId, collectionId, intent])`.
      On `Collection` add the back-relation `wantItems WantListItem[]`. On `UserCollection` add ONLY
      the documentation comment block (design §2b) describing `uc_variant_coalesced` — add NO
      `@@unique` and NO new column. Preserve ALL existing load-bearing comments.
      Files: `prisma/schema.prisma`
      Verify: with LOCAL DB env exported, `npx prisma validate` passes and `npx prisma generate`
      succeeds (a model is valid without `@@unique`). Record output.

- [ ] 8. **Create + hand-augment the first migration, apply to the LOCAL dev DB (design §3).**
      With LOCAL DB env exported, run `npx prisma migrate dev --name collection_buckets`. There is
      no `prisma/migrations/` folder today — this creates it. Then hand-augment the generated
      `prisma/migrations/<ts>_collection_buckets/migration.sql` with the ordered additive steps from
      design §3: STEP 1 add `collectionId` column + FK (SetNull); STEP 2 DEDUPE `user_collection`
      `WHERE isSold=false` BEFORE any unique (merge rule D-5 — oldest `addedAt` survives, summed
      `quantity`, documented lossy cost-basis collapse keeping only the survivor's basis, delete
      losers; sold rows NOT merged); STEP 3 `CREATE UNIQUE INDEX uc_variant_coalesced` partial
      `WHERE isSold=false` over `(userId, COALESCE(collectionId,''), cardId, isFoil,
      COALESCE(condition,''))` and `CREATE UNIQUE INDEX wli_scope_coalesced` over
      `(userId, cardId, intent, COALESCE(collectionId,''))`; STEP 4 `DROP INDEX IF EXISTS
      want_list_item_userId_cardId_intent_key` (Prisma emits this; keep it); STEP 5 keep the
      Prisma-generated `want_list_item_userId_collectionId_intent_idx` CREATE INDEX (do NOT
      hand-duplicate); STEP 6 the `DO $$` self-check that aborts if any active variant group still
      has >1 row. Re-apply the augmented SQL to the local DB (`npx prisma migrate dev` again picks up
      the edited file, or `npx prisma migrate reset` on the local dev DB if needed — LOCAL ONLY).
      COMMIT the generated + augmented migration under `prisma/migrations/`.
      Files: `prisma/migrations/<ts>_collection_buckets/migration.sql` (new), `prisma/migrations/migration_lock.toml` (new)
      Verify: with LOCAL DB env exported, the migration applies cleanly against
      `localhost:5433/dojo` and the STEP 6 self-check passes (no `RAISE EXCEPTION`). Then
      `npx prisma generate`. Record the migration folder name and the apply output.

- [ ] 9. **Create the pure `collection-scope.ts` util (design §4) → GREEN for steps 2, 5, 6 scope.**
      Create `src/lib/utils/collection-scope.ts` exactly per design §4: `CollectionScope` type
      (`all`/`collection`/`loose`); `toScope(selectionId)` collapsing `null`/`""`/`ALL_VIEW_ID`/
      `ALL_COLLECTIONS` → `{kind:"all"}`, `"__uncat__"` → `{kind:"loose"}`, else
      `{kind:"collection",id}`; `activeWhere(userId, scope)` and `soldWhere(userId, scope)` returning
      the plain Prisma `where` fragments (`isSold:false`/`true`; `collectionId:null` for loose; no
      `collectionId` key for all). Import `ALL_VIEW_ID` and `ALL_COLLECTIONS` from their existing
      modules. Client-safe — NO imports from `@/lib/db` or any server-only module.
      Files: `src/lib/utils/collection-scope.ts`
      Verify: `npx vitest run tests/unit/collection-scope.test.ts` passes; the
      `collection-aggregation.test.ts` scope cases from step 2 now pass.

- [ ] 10. **Create the pure `collection-buckets.ts` util (design §5) → GREEN for step 5 buckets.**
      Create `src/lib/utils/collection-buckets.ts` exactly per design §5: `BucketId`, `BucketLot`,
      `BucketWant`, `Buckets<L,W>` types and `selectBuckets(lots, wants, scope)` — partitions scoped
      lots into `main`/`all`/`sold` and scoped wants into `buy`/`sell`; for `{kind:"all"}` returns
      `main:[]`, `sold:[]`, `all`=union; TRADE excluded; pure (no I/O, no `Date.now`, no mutation).
      Client-safe.
      Files: `src/lib/utils/collection-buckets.ts`
      Verify: `npx vitest run tests/unit/collection-buckets.test.ts` passes.

- [ ] 11. **Update the want-list validators + service (design §6c) → GREEN for want-list-scoping.**
      In `src/lib/validators/want-list.validator.ts`: add `collectionId: z.string().trim().min(1).nullish()`
      to `AddWantListSchema` and to `MoveWantListSchema` (no `.max`). In
      `src/lib/services/want-list.service.ts`: change `listWantList(userId, opts?: {intent?; collectionId?})`
      to the options-object signature with the `where` assembly from §6c (omit `collectionId` key when
      absent; `null` selects account-level); replace the `upsert` in `addWantListItem` with the
      explicit `findFirst({where:{userId,cardId,intent,collectionId:scope}}) → return existing or
      create` idempotent find-or-create; change `moveWantListItem(userId, id, {intent, collectionId?})`
      to the object signature that updates `data:{intent, …("collectionId" in data ? {collectionId} :
      {})}` ownership-scoped `where:{id,userId}`. Preserve display-field resolution by
      `Card.externalId` and all load-bearing comments.
      Files: `src/lib/validators/want-list.validator.ts`, `src/lib/services/want-list.service.ts`
      Verify: `npx vitest run tests/integration/want-list-scoping.test.ts` passes.

- [ ] 12. **Thread `collectionId` through the want-list routes (design §6c) → GREEN for step 6 wiring.**
      In `src/app/api/want-list/route.ts` GET: read `collectionId` from the query string
      (`__account__`→`null`, present non-empty→that id, absent→omit the key) and call
      `listWantList(userId, { intent, collectionId })` (fix the positional call). POST: pass
      `collectionId` through to `addWantListItem`; keep the idempotent 201 contract and catch a
      concurrent P2002 on `wli_scope_coalesced` → re-read → same 201 (never a 409 for a duplicate
      add). In `src/app/api/want-list/[id]/route.ts` PATCH: parse the WHOLE body with
      `MoveWantListSchema.safeParse(body)` and call `moveWantListItem(userId, id, parsed.data)`; the
      existing P2025→404 / P2002→409 catch stays (P2002 now fires off `wli_scope_coalesced`). DELETE
      unchanged. Add the pre-write ownership guard: when a non-null `collectionId` is supplied,
      `prisma.collection.findFirst({where:{id:collectionId,userId}})` → 404 on miss (design §9).
      Files: `src/app/api/want-list/route.ts`, `src/app/api/want-list/[id]/route.ts`
      Verify: `npx vitest run tests/integration/collection-scope.test.ts` passes (want-list GET
      mapping cases green); `want-list-scoping.test.ts` still green.

- [ ] 13. **Add `listCollectionsWithBuckets` + wrap `GET /api/collections` (design §6a) → GREEN F-10 bucket cases.**
      In `src/lib/services/collection.service.ts` add `listCollectionsWithBuckets(userId)`: step-1
      `collection.findMany` (NOT wrapped), step-2 `userCollection.groupBy({by:["collectionId","isSold"],
      _sum:{quantity:true}})` and step-3 `wantListItem.groupBy({by:["collectionId","intent"],
      _count:{_all:true}})` each wrapped in a local `safeGroupBy` (catch → empty `Map`); assemble each
      collection's `buckets` in memory with `?? 0` so a miss is always 0, including a `__uncat__`
      pseudo-collection for `collectionId:null`. UNITS: `main`/`all`/`sold` = `_sum.quantity`,
      `buy`/`sell` = `_count._all`. In `src/app/api/collections/route.ts` GET: call
      `listCollectionsWithBuckets` inside a try/catch; catch logs `console.error` and returns HTTP 200
      `{data:[]}` with `Cache-Control:no-store` (so step-1 failure → empty list, step-2/3 failure →
      full list with zeroed buckets).
      Files: `src/lib/services/collection.service.ts`, `src/app/api/collections/route.ts`
      Verify: `npx vitest run tests/integration/collections.test.ts` — the `listCollectionsWithBuckets`
      + degradation cases pass.

- [ ] 14. **Add-flow exact-condition compare + P2002 race, and PATCH `[id]` 409 + ownership (design §6d, §6f) → GREEN remaining F-10 cases.**
      In `src/app/api/users/me/collection/route.ts` POST: replace the `existingItem` finder with the
      exact normalized-`condition` equality match (`norm(c)=(c??"").trim().toUpperCase()`,
      `norm(existing.condition)===norm(item.condition)`) so app-side identity matches
      `COALESCE(condition,'')`; wrap the `prisma.userCollection.create` in a try/catch that, on
      `Prisma.PrismaClientKnownRequestError` code `P2002`, re-reads the raced lot via the same scoped
      `findFirst` + exact-condition match and increments its quantity (`ok:true`), else rethrows.
      Preserve `assignBulkAddOrder`, cost-basis capture, and the best-effort add-snapshot write. In
      `src/app/api/users/me/collection/[id]/route.ts` "General update" branch: before the update, when
      `collectionId != null`, `prisma.collection.findFirst({where:{id:collectionId,userId}})` → 404 on
      miss; wrap the `update` in a catch mapping `P2002` whose `meta.target` includes
      `uc_variant_coalesced` → 409 "That variant is already in the target collection", rethrow
      otherwise. The legacy sell-split branch is unchanged (already preserves `collectionId`).
      Files: `src/app/api/users/me/collection/route.ts`, `src/app/api/users/me/collection/[id]/route.ts`
      Verify: `npx vitest run tests/integration/collections.test.ts` — ALL cases (dedupe, P2002 race,
      PATCH 409, PATCH cross-user 404) pass.

- [ ] 15. **UI: per-collection 5-bucket chip bar + per-collection want list; verify dashboard stays Want-to-Buy-free (design §7).**
      Create `src/components/CollectionBucketBar.tsx` — a presentational 5-chip bar (Main · All · Want
      to Buy · Want to Sell · Sold) reading `buckets` counts from the `["collections"]` query, using
      `--color-dojo-*` tokens, square corners (radius 0), hard-offset shadows (no blur), and the
      canonical `ArrowRight` for any CTA (reuse the `.dojo-*` + inline-style pattern from
      `WantList.tsx`/`CollectionsSection.tsx`). Wire it into `CollectionsSection.tsx` per collection
      row. In `src/components/WantList.tsx`: add an optional `collectionId` prop (default `undefined` =
      account/all view); build the fetch URL with `URLSearchParams` (encoded); change the query key to
      `["want-list", intent, collectionId ?? "__account__"]`; thread `collectionId` into move/add; keep
      the whole-`["want-list"]`-family invalidation. Do NOT touch `DashboardClient.tsx`'s `collOptions`
      counting (client-side counts stay) — only CONFIRM `__want_buy__` stays absent from `collOptions`.
      Files: `src/components/CollectionBucketBar.tsx` (new),
      `src/app/(dashboard)/you/_components/CollectionsSection.tsx`, `src/components/WantList.tsx`
      Verify: with LOCAL DB env exported, `npx prisma generate` then `npm run type-check` is clean, and
      `grep -n "__want_buy__" "src/app/(dashboard)/dashboard/_components/DashboardClient.tsx"` returns
      NOTHING (FR-7 — the injection stays removed). Record both.

- [ ] 16. **Update docs + e2e specs in the SAME change (design §10, §8); do NOT run e2e as a gate.**
      Update `docs/ARCHITECTURE.md` (correct the stale `UserCollection [userId, cardId, isFoil]` unique
      claim to the real `uc_variant_coalesced` partial expression index; document
      `WantListItem.collectionId` + `wli_scope_coalesced`; add the `["want-list", intent, collectionId]`
      TanStack key dimension + invalidation note), `docs/API_REFERENCE.md` (want-list GET
      `?collectionId=` / POST `collectionId` body; collections GET `buckets` object with the
      quantity-sum vs row-count units note; correct the `UserCollection` unique note), and
      `docs/CODE_MAP.md` (add `src/lib/utils/collection-scope.ts`, `src/lib/utils/collection-buckets.ts`,
      `src/components/CollectionBucketBar.tsx` + consumers). Update `e2e/collections-ui.spec.ts` (5-bucket
      chip bar inside a collection, Main==All content, per-collection Sold, dashboard shows NO
      Want-to-Buy option) and `e2e/want-list.spec.ts` (collection-scoped want list; `/wantlist` shows
      account-level rows) to the new behavior. e2e is NOT part of the verification gate here.
      Files: `docs/ARCHITECTURE.md`, `docs/API_REFERENCE.md`, `docs/CODE_MAP.md`,
      `e2e/collections-ui.spec.ts`, `e2e/want-list.spec.ts`
      Verify: `npm run lint` passes (specs compile). Docs reviewed for the corrected unique claim.

---

## Step 17 — full verification gate (worktree, LOCAL DB env)

- [ ] 17. **Run the full gate and record every result.** With the LOCAL DB env exported for each
      command, in this exact order:
      1. `npx prisma generate` (ALWAYS before type-check).
      2. Confirm the migration is applied to the local DB (step 8).
      3. `npm run lint` — clean.
      4. `npm run type-check` — MUST be clean (no TS errors).
      5. `npm run build` — a `next/font/google` OFFLINE font-fetch failure in
         `src/app/layout.tsx` is a KNOWN pre-existing offline issue, NOT caused by this work. If
         (and only if) the build fails solely on that offline font fetch, treat green
         lint+type-check+unit+integration as passing and SAY SO explicitly in the verification log.
      6. `npm run test:unit` — all pass (new `collection-scope`, `collection-buckets`; updated
         aggregation + series).
      7. `npm run test:integration` — all pass (updated collections + compare; new
         want-list-scoping + collection-scope).
      Do NOT run `test:e2e` or `test:chart-accuracy` as a gate here (e2e specs were updated but are
      not the gate; no Scrydex credits). Confirm the credit gate is still default DENY and NO
      external/Scrydex call was made.
      Verify: all of 1,3,4,6,7 green; 5 green OR only-the-known-font-failure (documented). Append the
      full command list + results to the "Verification log" below.

---

## Verification log (implementer appends command + result here for the reviewer)

Iteration 1 (from scratch, TDD red→green). Worktree
`d:\Pokemon\.worktrees\feat-collection-buckets-v2`, LOCAL DB env
`DATABASE_URL/DIRECT_URL=postgresql://dojo:dojo@localhost:5433/dojo`,
`REDIS_URL=redis://localhost:6380`. No `collection-buckets-review.json` existed → iteration 1.

RED (tests first):
- `npx vitest run` the 7 new/changed test files BEFORE implementing → 5 files failed for the
  EXPECTED reasons (missing `@/lib/utils/collection-scope`, `collection-buckets`, new service
  signatures, un-wrapped routes); `compare-collections` + `collection-series` stayed green
  (regression pins, documented).

GREEN gate (final):
- `npx prisma validate` → schema valid.
- `npx prisma generate` → OK.
- Migration: `prisma/migrations/20250101000000_collection_buckets/migration.sql` created
  (hand-augmented: STEP1 column+FK SetNull, STEP2 dedupe isSold=false oldest-addedAt survivor
  with documented lossy cost-basis collapse, STEP3 `uc_variant_coalesced` partial +
  `wli_scope_coalesced` expression unique indexes, STEP4 drop old want unique, STEP5 new plain
  index, STEP6 DO $$ self-check). Applied to LOCAL DB via `prisma db execute` → "Script
  executed successfully" (STEP6 self-check passed, no RAISE EXCEPTION). This is the FIRST real
  migration (project previously used `db push`); applied via `migrate diff` + `db execute`
  rather than `migrate dev --reset` to avoid wiping local seed data. NEVER pointed at Supabase.
- `npm run lint` → clean (eslint, 0 errors; e2e specs compile).
- `npm run type-check` → clean (tsc --noEmit, 0 errors).
- `npm run build` → SUCCESS (all routes compiled incl. /api/want-list, /api/collections,
  /you, /wantlist, /dashboard). The known offline next/font/google failure did NOT occur this
  run (fonts cached); build was fully green.
- `npm run test:unit` → 20 files, 127 passed (incl. new collection-scope 12, collection-buckets
  8; updated collection-aggregation 9, collection-series 7).
- `npm run test:integration` → 14 files, 112 passed (incl. updated collections 17 [buckets +
  exact-condition dedupe + P2002 race + PATCH 409/404], compare-collections 8 [+ null-row
  regression]; new want-list-scoping 8, collection-scope 3).
- e2e NOT run as a gate (specs updated only).

ZERO Scrydex credits: `src/lib/services/scrydex-credit-gate.ts` NOT modified (absent from
`git status`); `SCRYDEX_LIVE_CREDITS_APPROVED` never set; the `scrydex:credit-approval` Redis
flag never touched; no external/Scrydex call made. Credit gate stays default DENY.

---

## Notes / assumptions

- **Supabase vs LOCAL DB:** the design text references the remote Supabase `directUrl` for
  migrations; the step prompt overrides this — ALL DB work targets the LOCAL dev DB
  (`localhost:5433/dojo`). Treat the local DB as authoritative; never run `migrate dev` against
  Supabase.
- **Steps 1–6 are RED by construction.** Step 3 (F-22) and step 4 (series) stay green because
  their underlying utils are unchanged — they are regression pins, documented as such; the true
  RED drivers are steps 1, 2, 5, 6.
- **Buckets are purely derived (D-4).** No bucket table/enum is added; the only stored structure
  is `WantListItem.collectionId` + the two expression indexes.
- **One runnable check per non-trivial unit:** `collection-buckets.test.ts` for the selector, the
  migration `DO $$` self-check for the dedupe, `collection-scope.test.ts` for the resolver,
  `want-list-scoping.test.ts` for the idempotent find-or-create + 409.
