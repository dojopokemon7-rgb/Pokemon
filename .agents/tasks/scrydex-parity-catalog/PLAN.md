# Implementation Plan — Scrydex-Parity Per-Printing Catalog Re-Model (BOTH games)

> Authoritative spec: `design.md` (Rev 3) + `design-addendum.md` (resolves HIGH-1/MEDIUM-1/MEDIUM-2
> + nits — the addendum WINS on those items) + `requirements.md` (24 acceptance criteria), all in
> this folder. `PLAN.md` lives at the REPO ROOT (`d:\Pokemon\Pokemon\.agents\tasks\scrydex-parity-catalog\PLAN.md`).
>
> ALL work is in the worktree `d:\Pokemon\Pokemon\.worktrees\scrydex-parity-build` (branch
> `scrydex-parity-build`). All git via `git -C "d:\Pokemon\Pokemon\.worktrees\scrydex-parity-build"`.
> No push, no commit to master (NFR-7/AC-24). The owner runs the paid Scrydex pull — the build
> NEVER opens the credit gate or runs a live paid pull (offline unit/integration tests only).
>
> Verify commands (worktree root; the repo path has a space — quote it):
> `npm run type-check`, `npm run lint`, `npm run test:unit` (runs `tests/unit` AND `src`),
> `npm run test:integration`. These four are the quality gate (AC-23).

---

## Locked decisions (do NOT re-litigate — from design.md §1 + addendum)

- Per-printing key = composite `Card.externalId`: base printing keeps the EXISTING row's
  `externalId` verbatim; non-base printings are `"${baseId}::${variantName}"`.
- `baseId` resolution: One Piece `baseId = card.id` (Bandai code IS the existing externalId).
  Pokémon = MATCH-THEN-UPSERT (find existing row by `scrydexId == c.id`, else `game + set NAME +
  number`); reuse that row's `externalId`; green-field `baseId = c.id` only when no row matches.
- `baseVariantName` = "normal" if present (case-insensitive), else lexicographically-smallest
  `variant.name` (ORDER-INDEPENDENT — not array position).
- Per-printing image = `pickImageEntry(variant.images) ?? pickBaseImageUrl(card)` (base art
  fallback for EVERY printing; drop as invalid only when the base card is also imageless).
- Migration is ADD-ONLY (addendum MEDIUM-2): base = `update` onto matched row, non-base =
  `create`. ZERO deletes — no guarded-delete helper ships.
- Per-set transactional apply (addendum HIGH-1 Option A): Pass 1 page+buffer mapped rows keyed by
  set; Pass 2 one `prisma.$transaction` per `CardSet` with before/after counts + assertions.
- Credit-gate import = `@/lib/services/scrydex-credit-gate` (NIT-1 — NOT the AGENTS.md `utils/` path).
- `pull-full-catalog.ts` is git-ignored + absent from the worktree: `Copy-Item` it from the repo
  root (NIT-3); its committed artifact is the mapper/helper edits, the runnable script stays local.

---

## Phase 1 — Schema migration + shared pure helpers

- [ ] 1. Add the two pure helpers `baseVariantName(variantNames: string[])` and
      `printingExternalId(baseId, variantName, baseName)` to `card-number.ts` exactly as design.md
      §4.1 specifies (normal-else-lexicographically-smallest; base keeps `baseId`, non-base gets
      `::${variantName}`). Pure, no imports.
      Files: `d:\Pokemon\Pokemon\.worktrees\scrydex-parity-build\src\lib\utils\card-number.ts`
      Verify: `npm run type-check` passes (helpers compile). Full unit coverage lands in item 3.

- [ ] 2. Edit `schema.prisma` `model Card`: add `printing String?`; change `scrydexId String? @unique`
      → `scrydexId String?` and add `@@index([scrydexId])`. Author the Prisma migration directory
      `prisma/migrations/<timestamp>_card_per_printing_model/migration.sql` with raw SQL (mirror the
      `20250111000000_card_variant_images` style, `IF (NOT) EXISTS` idempotent): `ALTER TABLE "card"
      ADD COLUMN IF NOT EXISTS "printing" TEXT;` + `UPDATE "card" SET "printing"='normal' WHERE
      "printing" IS NULL;` + `DROP INDEX IF EXISTS "card_scrydexId_key";` + `CREATE INDEX IF NOT
      EXISTS "card_scrydexId_idx" ON "card" ("scrydexId");`. Add an `APPLY.md` in the migration dir
      (owner runs `npx -y prisma@6 migrate deploy`; NEVER auto-run against Mumbai). Run
      `npx -y prisma@6 generate` so the client types pick up `printing` + the relaxed `scrydexId`.
      NO `number` uniqueness exists to drop (confirmed — `Card` declares only `externalId @unique`
      + `scrydexId @unique` + the `@@index` set); state that in the SQL comments (AC-3).
      Files: `...\prisma\schema.prisma`,
      `...\prisma\migrations\<timestamp>_card_per_printing_model\migration.sql`,
      `...\prisma\migrations\<timestamp>_card_per_printing_model\APPLY.md`
      Verify: `npm run type-check` passes (generated client exposes `card.printing` + non-unique
      `scrydexId`). Do NOT run `migrate dev`/`db:push` against the remote DB (owner-run only).

- [ ] 3. Add unit tests for the two helpers in `tests/unit/card-number.test.ts` (create or extend):
      `baseVariantName(["normal","foil"])==="normal"`; `baseVariantName(["foil","alt art"])==="alt art"`;
      order-independence `baseVariantName(["foil","alt art"])===baseVariantName(["alt art","foil"])`;
      `printingExternalId("base1-4","normal","normal")==="base1-4"`;
      `printingExternalId("base1-4","reverse holofoil","normal")==="base1-4::reverse holofoil"`.
      Files: `...\tests\unit\card-number.test.ts`
      Verify: `npm run test:unit` — the new card-number cases pass.

## Phase 2 — Ingest rewrite (BOTH games), one Card row per variant

- [ ] 4. Rewrite the One Piece mapper/upsert in `scripts/ingest-onepiece-catalog.ts`:
      `mapScrydexCatalogCard(card)` returns `MappedOnePieceCard[]` (one per `card.variants[]` entry),
      `baseId = card.id`, `base = baseVariantName(names)`, each row
      `externalId = printingExternalId(card.id, variant.name, base)`, `number` unchanged
      (`deriveStoredCardNumber(card.id, true)`), `printing = variant.name || "normal"`,
      `imageUrl = pickImageEntry(variant.images) ?? pickBaseImageUrl(card)`, prices from THIS
      variant's `prices[]`, each row re-validated through `NormalizedCardSchema` (drop → `invalid`).
      Add `printing` to `MappedOnePieceCard`; DROP `variantImages` from the mapped shape.
      `upsertOnePieceCard` keys on the composite `externalId`, writes `printing`, writes that
      printing's `CurrentPrice` rows, sets `game: ONE_PIECE`. REMOVE the `variantImages` write branch
      + the `canonical(variantImages)` unchanged-comparison term + dead `hasVariantImages`/`canonical`/
      `VariantImageMap` locals (NIT-4); replace the dropped unchanged term with `prior.printing === m.printing`.
      Keep `onePieceSetExternalId(setName)` set keying (FR-2.7). Update the runner loop to iterate the
      returned array. CurrentPrice writes: upsert on the existing `@@unique([cardId,source,currency,
      variant,condition,company,grade,type])` tuple (this printing's variant only).
      Files: `...\scripts\ingest-onepiece-catalog.ts`
      Verify: `npm run type-check` + `npm run lint` pass; existing
      `tests/integration/ingest-onepiece-catalog.test.ts` is updated in item 7 (will fail until then —
      expected). Run `npm run test:integration` after item 7.

- [ ] 5. Bring `pull-full-catalog.ts` into the worktree (NIT-3, git-ignored — filesystem copy, NOT
      `git show`): `Copy-Item "d:\Pokemon\Pokemon\scripts\pull-full-catalog.ts"
      "d:\Pokemon\Pokemon\.worktrees\scrydex-parity-build\scripts\pull-full-catalog.ts"`. The copy is
      itself git-ignored; the committed artifacts are the pure mapper/helper edits (item 6).
      Files: `...\scripts\pull-full-catalog.ts` (local, ignored)
      Verify: the file exists at the worktree path (`Test-Path`).

- [ ] 6. Rewrite the Pokémon mapper in `scripts/pull-full-catalog.ts`: replace `buildCardRow(c,setId,
      game)` with `buildCardRows(c, setId, game, baseId): Row[]` (one row per `c.variants[]`),
      `base = baseVariantName(names)`, `externalId = printingExternalId(baseId, variant.name, base)`,
      `scrydexId = c.id` (now non-unique), `number = c.number ?? ""` unchanged,
      `printing = variant.name || "normal"`, `imageUrl/imageUrlHi` from
      `pickImageEntry(variant.images) ?? pickBaseImageUrl(c)`, and headline `marketPrice`/`weeklyChange*`
      from THIS variant's NM-raw entry + its `trends.days_7` (NIT-4 — never `variants[0]`/flatMap).
      Replace `buildPriceRows(c,cardId)` with `buildPriceRows(variant, cardId)` scoped to one variant's
      `prices[]`. Keep Pokémon set key `pokemon-<exp.id>`. Keep these as PURE exported functions so the
      unit test imports the seam without the live runner. (The match-then-upsert `baseId` resolution +
      the credit gate / dry-run / `--apply` / per-set transaction live in the orchestrator, FEAT-003 —
      this item only makes the mappers per-printing + pure.) `pickBaseImageUrl(c)` helper reads the
      top-level `c.images` front entry (`pickImageEntry`).
      Files: `...\scripts\pull-full-catalog.ts`
      Verify: `npm run type-check` passes against the imported pure functions (item 8 adds the test).

- [ ] 7. Update `tests/integration/ingest-onepiece-catalog.test.ts` for the array-returning mapper:
      a 2-variant card → 2 rows with distinct composite externalIds (`OP08-023`, `OP08-023::alt-art`),
      each carrying its own `printing`/`imageUrl`/price; base keeps the bare externalId; imageless
      alt variant falls back to base art (NOT dropped); a card whose base art is ALSO absent → that
      printing dropped `invalid`; idempotent re-run → `skipped`; upsert sets `game: ONE_PIECE`.
      Files: `...\tests\integration\ingest-onepiece-catalog.test.ts`
      Verify: `npm run test:integration` — the One Piece ingest tests pass.

## Phase 3 — Gated owner-run reingest/migration orchestrator + parity verify

- [ ] 8. Create `scripts/reingest-per-printing.ts` — the owner-run orchestrator (Droplet one-off
      pattern, PLAN.md §6). Imports `assertScrydexCreditsApproved`/`estimateCredits` from
      `@/lib/services/scrydex-credit-gate` (NIT-1). Flags: `--game=onepiece|pokemon` (One Piece first),
      `--apply` (default = dry run). DRY RUN: one gated page-1 fetch → print `total_count` + sample
      (showing composite externalIds + printing labels) + per-game credit estimate (OP≈29, PKM≈475) +
      before-counts, NO writes. `--apply`: two-pass per addendum HIGH-1 — Pass 1 page+buffer mapped
      rows keyed by set grouping key (OP `onePieceSetExternalId(setName)`, PKM `pokemon-<exp.id>`) and
      resolve Pokémon `baseId` via read-only match-then-upsert (`scrydexId==c.id`, else `game + set
      NAME + number`); Pass 2 one `prisma.$transaction` per CardSet doing base-`update`/non-base-`create`,
      with per-set before/after `Card`+`CurrentPrice`+`UserCollection` counts and the two assertions
      (addendum MEDIUM-1): (1) ≤1 base (no `::`) per number+set, (3) `after.cardCount - before.cardCount
      === created_nonBase_thisRun` — any failure throws → set rolls back → run halts non-zero. For
      `--game=pokemon`, run the §1.2 read-only pre-check FIRST and REFUSE `--apply` if any seed set
      name doesn't line up with a Scrydex expansion name (unless `--i-accept-set-name-miss`). At END of
      a successful `--apply`, flush search caches `card:searchq:*` + `card:search:*` (SCAN+UNLINK,
      try/catch, non-fatal per RULE 1). `assertScrydexCreditsApproved("standard", pages)` before ANY
      live fetch (DENY by default — never opened by the build). Keep pure logic (buffer keying, assertion
      math, baseId resolution) in exported functions for the unit/integration tests.
      Files: `...\scripts\reingest-per-printing.ts`
      Verify: `npm run type-check` + `npm run lint` pass. Dry-run is NOT executed live (owner-run).

- [ ] 9. Create `scripts/verify-parity.ts` — dry-run-default parity check (design.md §8.3). Offline
      half (no credits): assert the DB holds the expected N per-printing rows + labels for a known
      number per game (One Piece `OP01-120`; a chosen multi-printing Pokémon card) by reading the DB
      directly (NOT the cached search route). Live half (one gated Scrydex `variants[]` read) ONLY with
      owner credit approval. Import the credit gate from `@/lib/services/scrydex-credit-gate`.
      Files: `...\scripts\verify-parity.ts`
      Verify: `npm run type-check` + `npm run lint` pass.

- [ ] 10. Add integration tests (mocked Prisma, NO network/credits) in
      `tests/integration/reingest-per-printing.test.ts`: (a) Pokémon match-then-upsert — a seeded row
      `externalId="base1-4", scrydexId=null` + Scrydex card `{id:"me55c-4",number:"4",variants:[normal,
      reverse holofoil]}` same set → base row keeps `externalId="base1-4"` (NOT `me55c-4`), non-base =
      `base1-4::reverse holofoil`; a second case with `scrydexId="me55c-4"` populated → match-by-scrydexId
      also reuses `base1-4`. (b) Per-set assertion math: a clean re-run yields `created_nonBase=0` and
      `after-before=0` → assertion (3) passes (re-run safe, AC-5); a cross-set split (green-field base +
      N-1 non-base in the Scrydex-keyed set) → `after-before=N` vs `created_nonBase=N-1` → assertion (3)
      FIRES. Import the orchestrator's pure functions (NOT the live runner).
      Files: `...\tests\integration\reingest-per-printing.test.ts`
      Verify: `npm run test:integration` — the reingest tests pass.

- [ ] 11. Add Pokémon mapper unit test in `tests/unit/pull-full-catalog.mapper.test.ts` (or a
      `tests/integration/` file if the import graph needs Prisma types): a 3-variant Scrydex card →
      3 rows with distinct composite externalIds, each its own `printing`/`imageUrl`/headline price
      from ITS variant (NOT variant-0); image fallback — a variant with empty `images` but a base
      `c.images` → its row carries the base art (not dropped); base card with no image → that printing
      dropped. Import the pure `buildCardRows`/`buildPriceRows`/`pickBaseImageUrl` seam.
      Files: `...\tests\unit\pull-full-catalog.mapper.test.ts`
      Verify: `npm run test:unit` — the Pokémon mapper cases pass.

## Phase 4 — Search / explore / collection UI parity

- [ ] 12. Surface the printing label on reads. Add OPTIONAL `printing: z.string().nullish()` to
      `NormalizedCardSchema` (additive/nullable — old cached blobs still validate). In
      `src/app/api/cards/search/route.ts` add `printing: true` to the `find()` `select` and set
      `printing: r.printing ?? null` on each mapped `NormalizedCard`. In
      `src/app/api/cards/trending/route.ts` add `printing: true` to `TRENDING_SELECT` and include
      `printing: c.printing ?? null` on each card. Per-printing price/image already flow per-row
      (`pickHeadlineRaw(currentPrices) ?? marketPrice`; `r.imageUrl`) — no query rewrite, offset
      pagination retained (AGENTS.md §12). filter-options stays by set name — confirm UNCHANGED (no edit).
      Files: `...\src\lib\validators\card.validator.ts`, `...\src\app\api\cards\search\route.ts`,
      `...\src\app\api\cards\trending\route.ts`
      Verify: `npm run type-check` + `npm run lint` pass; `npm run test:integration` (search parity +
      filter-options tests from item 14) pass.

- [ ] 13. Make the add-to-collection new-card fallback composite-safe (design.md §6.3, MEDIUM-2):
      in `src/app/api/users/me/collection/route.ts` POST, before deriving the number in the
      `prisma.card.create` fallback, split the base id:
      `const baseExt = item.externalId.split("::")[0];` and use
      `number: deriveStoredCardNumber(baseExt, isOnePieceCode(baseExt))`. One-line change; no-op for
      non-composite ids. Do NOT change `AddCardSchema`. The per-variant `uc_variant_coalesced`
      uniqueness is UNCHANGED (distinct `cardId` per printing makes Alt Art vs Foil distinct rows
      automatically — AC-19).
      Files: `...\src\app\api\users\me\collection\route.ts`
      Verify: `npm run type-check` passes; `npm run test:integration` (collection/number-derivation
      test from item 14) passes.

- [ ] 14. Retire the `variantImages` variant-identity display path (design.md §6.4) + add UI
      integration tests. Detail page `src/app/(dashboard)/search/[id]/page.tsx`: the hero reads the
      per-printing row's `imageUrl` directly — remove the `onePieceVariantImageUrl(variantImages, variant)`
      hero resolution. Prices route `src/app/api/cards/[id]/prices/route.ts`: drop `variantImages` from
      the payload + `PricesCacheSchema` (shape bump → old blobs miss → live read). Price writer
      `src/lib/services/scrydex-pricing.service.ts`: remove the `pickVariantImages` write block (last
      writer of `variantImages`). Scanner/recognize keep the null-tolerant `variantImages` read (now
      always `{}`) — `ponytail:` dormant read, upgrade path = per-printing candidates (out of scope).
      The `variantImages` COLUMN stays (nullable, back-compat). Add integration tests:
      `tests/integration/` — search parity (seed N per-printing rows → N results w/ distinct
      labels/prices/images, AC-15/16/17), filter-options unchanged semantics (AC-18), add-to-collection
      two printings → two rows + repeat-add increments (AC-19), and the composite number-derivation
      fallback (`"OP01-120::alt-art"` → number `"OP01-120"`; `"base1-4::reverse holofoil"` → `"4"`).
      Files: `...\src\app\(dashboard)\search\[id]\page.tsx`, `...\src\app\api\cards\[id]\prices\route.ts`,
      `...\src\lib\services\scrydex-pricing.service.ts`, new test file(s) under `...\tests\integration\`
      Verify: `npm run type-check` + `npm run lint` + `npm run test:unit` + `npm run test:integration`
      all pass (the full AC-23 quality gate).

## Phase 5 — Full quality gate (final)

- [ ] 15. Run the complete worktree quality gate and fix any fallout. Confirm no production write path
      populates `variantImages` for variant identity; confirm filter-options is unaffected; confirm the
      owner-run scripts were NOT executed live (no credits spent, no Mumbai writes).
      Files: (none — verification only; fix regressions in place)
      Verify: `npm run type-check`, `npm run lint`, `npm run test:unit`, `npm run test:integration` all
      pass with zero errors (AC-23). Grep checks are NOT verification — the four commands are the gate.

---

## Gaps / assumptions
- Prisma CLI must be pinned to v6 (`npx -y prisma@6 …`) per PLAN.md §6 — plain `npx prisma` fetches a
  v8 RC. The build only runs `prisma@6 generate` (type generation); `migrate deploy` is owner-run.
- The migration's `printing='normal'` backfill runs once at deploy; the re-ingest then overwrites
  `printing` per printing. Safe to apply before the re-ingest (additive + index swap only).
- `test:unit` runs BOTH `tests/unit` and `src`; keep new pure tests under `tests/unit`.
- The chosen multi-printing Pokémon sample for parity (item 9/11) is picked by the implementer from a
  card with reverse-holo + holo + normal; document the pick in the script.
