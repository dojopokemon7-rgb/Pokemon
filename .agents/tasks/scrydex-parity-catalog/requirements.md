# Requirements — Full Scrydex-Parity Catalog Re-Model (both games)

> Companion to `PLAN.md` (same folder) and the One Piece set-dedup `findings.md`
> (`.agents/tasks/onepiece-catalog-audit/findings.md`). PLAN.md's Phase-0 findings
> are AUTHORITATIVE and NOT re-derived here — this document turns the approved goal
> into testable requirements for Phases 1–5, for BOTH One Piece and Pokémon.
>
> Scope of THIS document: requirements only. No code, no schema edits, no design
> decisions beyond stating the constraints the design must satisfy. The design step
> that follows makes the concrete choices (and must honor every HARD CONSTRAINT below).

---

## Summary

The Dojo catalog stores **one `Card` row per card NUMBER**, collapsing all of a card's
printings/variants (foil, reverse-holo, alt-art, manga alt-art, reprint, secret rare,
1st-edition, etc.) into a single row and demoting the variants to a display-only
`Card.variantImages` JSON map with one price and one search result. Scrydex returns
**every printing** — each with its own art and its own price — nested in the
`variants[]` array of the catalog pages the ingest ALREADY pulls.

The goal is full Scrydex parity: **every Scrydex printing becomes its own searchable,
ownable, individually-priced `Card` row**, for BOTH games — "whatever we search in
Scrydex, the same must appear in our app." Per PLAN.md Phase 0, this is a pure
INGEST-MAPPING change (emit one `Card` per `variants[]` entry); it multiplies ROWS,
not PAGES, so a re-ingest costs the SAME ~504 Scrydex credits as the original pull
(~29 One Piece + ~475 Pokémon @ 1 credit/page) with NO extra API calls. Catalog grows
from ~53,456 rows to an estimated ~80k–160k rows (printing multiplier ~1.5×–3×).

The work spans five phases: (1) schema + per-printing identity model, (2) ingest
rewrite + gated re-ingest for both games, (3) migration of existing collapsed rows with
zero data loss, (4) search/explore/collection UI parity, (5) parity verification against
Scrydex. The migration must never leave the catalog half-migrated, must respect every
`onDelete: Cascade` chain, and must gate every credit-spending Scrydex call — the OWNER
runs the gated dry-run then `--apply` (One Piece first, then Pokémon).

### Assumptions (flagged for the design review)

- **A1 — Composite key is likely required.** The Scrydex catalog-list Zod schema
  (`ScrydexCardSchema` in `src/lib/services/scrydex.service.ts`) models ONE `id` per card
  with printings nested in `variants[]` (each `{ name, prices[], images[] }`). This means
  Scrydex does NOT appear to give each printing a distinct top-level `card.id`, so reusing
  `Card.externalId = card.id` verbatim cannot uniquely key a printing. The per-printing key
  will most likely be a composite such as `${card.id}::${variantName}`. **This is an
  assumption, not a fact** — FR-1.1 REQUIRES the ingest author to inspect the real raw
  Scrydex payload before locking the key (the Phase-0 one-credit probe in PLAN.md §Phase-0,
  plus the cached logs). PLAN.md §2 and §Phase-1 also left this open ("reuse externalId
  verbatim IF Scrydex gives each printing a distinct card.id, ELSE a composite key").
- **A2 — Cached raw payloads live at the REPO ROOT, not the worktree root.** The logs named
  in the task (`.full-pull-onepiece.log`, `.full-pull-pokemon.log`, `.full-pull.log`) exist
  at `D:\Pokemon\Pokemon\` (confirmed), NOT at the worktree root. They are summary/progress
  logs (small), not full raw JSON payloads, so FR-1.1's shape inspection cannot rely on them
  alone and must use the gated 1-credit probe for the authoritative variant shape.
- **A3 — WantListItem parity is at risk.** `WantListItem.cardId` stores the EXTERNAL card id
  (Bandai code / catalog id), NOT a FK to `Card.id` (schema comment confirms). If the
  per-printing key becomes a composite, existing want-list rows keyed on the bare number must
  still resolve to SOMETHING (the base printing). FR-3.6 covers this.
- **A4 — Pokémon is affected identically to One Piece** (PLAN.md Phase-0 §4): the Pokémon
  path `scripts/pull-full-catalog.ts` (`buildCardRow`/`buildPriceRows`) collapses the same
  nested-`variants[]` shape. Both games are in scope.
- **A5 — Staging-first is preferred but credit-bound.** If Scrydex credits allow, the
  re-ingest runs on staging (isolated `staging` Postgres schema) first; otherwise it runs
  per-set in transactions directly against prod with before/after counts (PLAN.md §Phase-2).
  The OWNER decides based on credit budget.

---

## Functional Requirements

### Phase 1 — Schema + per-printing identity model

- **FR-1.1 (key decision gated on real payload).** Before any schema or key decision is
  locked, the ingest author MUST inspect the REAL Scrydex catalog-list response shape —
  the `ScrydexCardSchema`/`VariantSchema` types in `src/lib/services/scrydex.service.ts`
  plus a live payload (the gated 1-credit page-1 probe from PLAN.md Phase-0, and/or the
  cached logs at the repo root per A2) — to determine whether each printing has a distinct
  top-level `card.id`. The chosen per-printing unique key MUST be documented with the
  evidence that justified it:
  - IF each printing has a distinct `card.id` → reuse `Card.externalId = card.id` verbatim
    (no key-schema change; the change is purely ingest + a printing-label column).
  - ELSE (the expected case, A1) → a deterministic composite key such as
    `${card.id}::${variantName}` (or a dedicated column), stable across re-ingests so the
    upsert is idempotent (FR-2.3).
- **FR-1.2 (printing-label column).** `Card` MUST carry a printing/variant/finish label
  equal to the Scrydex `variants[].name` (e.g. "normal", "reverse holofoil", "foil",
  "alt art", "manga", "reprint"), so the UI can distinguish printings of the same number.
  The label is captured verbatim from Scrydex; if a variant has no name, the schema default
  ("normal") is used.
- **FR-1.3 (keep number as non-unique display/grouping).** `Card.number` MUST remain the
  human Bandai/collector number (e.g. "OP01-120", "4"), NON-UNIQUE, used for display and for
  grouping printings of the same physical card. `deriveStoredCardNumber` behavior is
  preserved (One Piece = full Bandai code; Pokémon = tail segment).
- **FR-1.4 (keep game).** `Card.game` MUST remain and be set explicitly per row
  (`ONE_PIECE` / `POKEMON`) — the default is `POKEMON`, so One Piece rows must set it.
- **FR-1.5 (retire variantImages as the variant mechanism).** `Card.variantImages` MUST no
  longer be the mechanism by which variants are modeled. Each printing is now its own row
  with its own `imageUrl`. The column MAY remain nullable for back-compat but MUST NOT be
  the source of truth for variant art or variant identity after this change.
- **FR-1.6 (migration).** Any schema change MUST ship as a Prisma 6 migration (additive
  where possible; the printing-label column and any dropped `number` uniqueness expressed as
  a migration), applied via the pinned Prisma v6 CLI per PLAN.md §6. No `number` uniqueness
  may be introduced (printings share a number).
- **FR-1.7 (pricing per printing).** Each per-printing `Card` row MUST carry its OWN price
  rows. `CurrentPrice`/`PricingHistory` are already keyed by `cardId` and sub-keyed by
  `variant`; with per-printing rows, each printing's prices attach to its own `cardId`. The
  `CurrentPrice`/`PricingHistory` unique keys MUST remain valid (no collisions introduced by
  the re-model) and MUST NOT lose their existing variant/condition/company/grade/type
  discrimination.

### Phase 2 — Ingest rewrite + gated re-ingest (both games)

- **FR-2.1 (one row per variant, both games).** The ingest mappers MUST emit ONE `Card` row
  per `variants[]` entry, carrying THAT printing's own `imageUrl` (from
  `pickImageEntry(variant.images)`), its printing label (`variant.name`), and its own price
  rows (from `variant.prices[]`). This applies to BOTH the One Piece path
  (`scripts/ingest-onepiece-catalog.ts` — `mapScrydexCatalogCard` / `upsertOnePieceCard`)
  AND the Pokémon path (`scripts/pull-full-catalog.ts` — `buildCardRow` / `buildPriceRows`).
  The current collapse-to-one-row behavior (`mapScrydexCatalogCard` emitting one
  `MappedOnePieceCard` per `card.id`; `buildCardRow` one row per `c.id`) MUST be removed.
- **FR-2.2 (Zod at the boundary, RULE 4, RULE 2).** Every mapped printing MUST pass through
  the normalized validator before being accepted; a printing that cannot be honestly stored
  (no set name, empty name, no usable image URL) is DROPPED (counted `invalid`), never
  fabricated. A printing with no price yields `null` → UI "—" (RULE 2). A page/source that
  yields 0 valid cards does not fabricate rows.
- **FR-2.3 (idempotent upsert on the per-printing key).** Re-running the ingest over the same
  catalog MUST NOT create duplicate rows: upserts are keyed on the per-printing key from
  FR-1.1, and an unchanged printing is reported `skipped`. A second full run yields all
  `skipped` (modulo genuinely changed prices/metadata).
- **FR-2.4 (credit gate — DENY by default).** Every live, credit-consuming Scrydex call MUST
  pass `assertScrydexCreditsApproved(...)` from `scrydex-credit-gate.ts` (DENY by default).
  The re-ingest MUST print the page count and credit estimate before spending. The agent/dev
  MUST NOT open the gate or run a live paid pull — the OWNER runs the gated dry-run then
  `--apply`.
- **FR-2.5 (dry-run default + --apply).** The re-ingest script(s) MUST default to a dry run
  (read `total_count`, print a sample + the per-game credit estimate, NO writes) and perform
  writes ONLY with an explicit `--apply` flag after owner approval. This preserves the
  existing `ingest-onepiece-catalog.ts` dry-run/--apply contract and extends it to the
  Pokémon path.
- **FR-2.6 (before/after counts).** On `--apply`, the script MUST report before/after `Card`
  and `CurrentPrice` counts (and created/updated/skipped/invalid per the existing
  `IngestReport` shape) so the row multiplication is observable and auditable.
- **FR-2.7 (One Piece set-key guard-rail).** The re-ingest MUST apply the One Piece set-key
  guard-rail from the set-dedup audit: `pull-full-catalog.ts`'s `upsertSet` MUST derive the
  One Piece `CardSet.externalId` from the set NAME via `onePieceSetExternalId(setName)`
  (the `onepiece-<slug>` convention), NOT from the Scrydex `exp.id` (Bandai code), so the
  re-ingest can never recreate the phantom `onepiece-OP01` CODE-style set rows. Pokémon keeps
  its existing `exp.id`-based key (unaffected).
- **FR-2.8 (sequencing with reconcile-onepiece-sets).** The requirements MUST NOT re-run or
  fight the already-landed `scripts/reconcile-onepiece-sets.ts` (set-dedup, commit `b3f1d52`).
  The design MUST state the ordering (set reconciliation vs per-printing re-ingest) so the two
  cleanups do not conflict (PLAN.md §Phase-4).

### Phase 3 — Migration of existing collapsed rows (zero data loss)

- **FR-3.1 (no data loss).** NO `Card`, `CurrentPrice`, `PricingHistory`, `PopulationReport`,
  `SoldListing`, or owned `UserCollection` row may be lost. `CardSet→Card` and
  `Card→(price/history/population/sold/userCollection)` are all `onDelete: Cascade`, so any
  delete is destructive and is forbidden except per FR-3.4.
- **FR-3.2 (base printing upserts onto the existing row).** The re-ingest MUST upsert the
  base/normal printing of each number ONTO the EXISTING collapsed `Card` row (so its
  `Card.id` — and therefore every `UserCollection.cardId` FK pointing at it — is preserved),
  and ADD the other printings as NEW `Card` rows. The definition of "base/normal printing"
  (e.g. the `variant.name === "normal"` entry, else the first variant) MUST be deterministic
  and documented.
- **FR-3.3 (owned rows map to the base printing).** Every existing `UserCollection.cardId`
  (a real FK to `Card.id`) MUST continue to resolve after migration. Because owned collapsed
  cards map onto the preserved base-printing row (FR-3.2), existing owned rows are NOT
  orphaned and their `Card.id` does not change. Moving/adding rows MUST NOT re-point or
  delete any `UserCollection` row.
- **FR-3.4 (conditional delete of orphaned old rows).** An old collapsed `Card` row may be
  deleted ONLY if it is PROVEN to have ZERO owned references (`UserCollection` rows) — e.g. a
  pre-check query asserting `count = 0` for that `cardId` — AND the delete is accounted for in
  before/after counts. If owned references exist, the row is kept and reconciled, never
  deleted. The expected path (FR-3.2) avoids deletes entirely by reusing the base row; FR-3.4
  is the guarded exception, not the default.
- **FR-3.5 (per-set transactional migration).** Migration MUST proceed per-set inside
  transactions with before/after counts (or on staging first), so a failure rolls back and the
  catalog is never left half-migrated (HARD CONSTRAINT). A partial failure must leave a
  recoverable, consistent state.
- **FR-3.6 (WantListItem external-id resolution).** `WantListItem.cardId` stores the EXTERNAL
  id (Bandai code), not a FK. The migration MUST verify that existing want-list rows still
  resolve to a `Card` after the re-model (to the base printing, since the bare number maps to
  the base-printing row). The design MUST state how a want-list entry maps to a printing
  (expected: the base printing for that number) so no want-list row is silently broken.

### Phase 4 — Search / explore / collection UI (parity)

- **FR-4.1 (each printing is its own search result).** `GET /api/cards/search` MUST return
  each printing as its own result (flat list, Scrydex-style parity), carrying the printing
  label, the per-printing price, and the per-printing image. The result envelope
  (`NormalizedCard`) MUST continue to validate; the printing label must be surfaced so the UI
  can show "Foil"/"Alt Art"/etc.
- **FR-4.2 (per-printing price and image).** Each result's `marketPrice` and `imageUrl` MUST
  reflect THAT printing (its own `CurrentPrice` raw headline via `pickHeadlineRaw`, its own
  `imageUrl`), not a shared/base value. Unpriced printings show `null` → "—" (RULE 2).
- **FR-4.3 (filter-options unchanged, by set name).** `GET /api/cards/filter-options` MUST
  continue to list distinct set NAMES and rarities. Per-printing rows must not multiply the
  distinct set-name/rarity option lists (sets/rarities are de-duplicated already). Confirm the
  filter still groups by set name after the re-model.
- **FR-4.4 (add-to-collection keys per printing).** Add-to-collection
  (`POST /api/users/me/collection`) keys a lot on `cardId` (+ foil + condition). Because each
  printing is now its own `Card` row with its own `cardId`, owning "Alt Art Shanks" vs "Foil
  Shanks" MUST become distinct owned rows automatically. The existing per-variant uniqueness
  (`uc_variant_coalesced`: `userId, COALESCE(collectionId,''), cardId, isFoil,
  COALESCE(condition,'')`) MUST continue to hold and MUST NOT be weakened.
- **FR-4.5 (grade/condition dropdown unregressed; PSA-8.5 out of scope).** The grade/condition
  dropdown on the add/detail flow MUST continue to work after the re-model. The earlier
  PSA-8.5 / invalid-graded-data concern MUST NOT be regressed by this work, but FIXING that
  concern is explicitly OUT OF SCOPE.
- **FR-4.6 (retire the variantImages display path).** The UI path that reads
  `Card.variantImages` to show alternate art on a single collapsed row MUST be retired, since
  each printing now has its own `imageUrl`. No UI may depend on `variantImages` for variant
  identity or art after this change.

### Phase 5 — Parity verification

- **FR-5.1 (sample-card parity, both games).** For sample cards in BOTH games, the app's
  per-printing result set MUST match Scrydex's for that number:
  - **One Piece — Shanks `OP01-120`**: distinct printings (Foil, Alt Art, Manga Alt Art, etc.)
    MUST appear as SEPARATE, individually-priced search results.
  - **Pokémon — a multi-printing card** (e.g. a card with reverse-holo + holo + normal): those
    printings MUST appear as SEPARATE, individually-priced results.
- **FR-5.2 (automated check where feasible).** A parity check comparing the app's result set
  for a sample number against the Scrydex `variants[]` for that number (count of distinct
  printings + their labels) MUST be provided where feasible. Any live-Scrydex portion MUST be
  credit-gated and owner-run; the offline portion (asserting the DB holds N per-printing rows
  for a known number after migration) MUST run without credits.

---

## Non-Functional Requirements

- **NFR-1 (credits).** Total re-ingest spend is ~504 Scrydex credits (~29 One Piece + ~475
  Pokémon). No EXTRA per-variant API calls are introduced (variants are already in the pages
  pulled). The gate stays DENY-by-default; the OWNER approves and runs the paid pull.
- **NFR-2 (never half-migrated).** Any phase that cannot complete MUST roll back to a
  consistent state. Per-set transactions with before/after counts, or staging-first, are the
  mechanisms.
- **NFR-3 (server/client discipline).** Scrydex secrets and the service client stay
  server-only. No credential or raw Scrydex key reaches the browser.
- **NFR-4 (graceful degradation on public read routes).** Search / filter-options / trending
  remain HTTP 200 with empty/fallback payloads on error; they must not 5xx because of the
  larger catalog.
- **NFR-5 (quality gate).** TypeScript strict; `npm run type-check`, `npm run lint`,
  `npm run test:unit`, and `npm run test:integration` MUST pass. New/changed pure logic
  (mapper emitting one row per variant; migration base-row selection) carries at least one
  runnable unit/integration test.
- **NFR-6 (performance at scale).** The catalog roughly doubles-to-triples in row count.
  Existing search/trending indexes (`Card.@@index`, `current_price @@index([cardId])`,
  pg_trgm) MUST remain adequate; the design must note any index that needs attention (e.g. a
  per-number grouping read) rather than silently regressing the first-byte-critical paths.
- **NFR-7 (no push / no commit to master).** All work stays in the worktree; no push, no
  commit to master. Scripts run via the Droplet one-off-container pattern (PLAN.md §6).

---

## Acceptance Criteria

1. **AC-1 (key justified by evidence).** The chosen per-printing unique key is documented
   together with the real Scrydex payload evidence (probe output and/or schema) that shows
   whether printings have distinct `card.id`s. If a composite key is used, re-running the
   ingest produces zero duplicate rows for the same catalog.
2. **AC-2 (printing label present).** Every per-printing `Card` row has a non-empty printing
   label equal to its Scrydex `variants[].name` (default "normal" when Scrydex omits a name).
3. **AC-3 (number non-unique, game set).** `Card.number` is non-unique and multiple rows share
   the same number for a multi-printing card; `Card.game` is set correctly per row
   (One Piece rows are `ONE_PIECE`, not the `POKEMON` default).
4. **AC-4 (one row per variant, both games).** After the re-ingest (dry-run verified, then
   owner-run `--apply`), the One Piece and Pokémon ingest paths each emit one `Card` row per
   `variants[]` entry; a sample multi-printing number has as many rows as Scrydex has distinct
   printings for it.
5. **AC-5 (idempotent).** A second `--apply` run over the same catalog reports all rows
   `skipped` (no `created`, modulo genuine price/metadata changes).
6. **AC-6 (credit gate honored).** With the gate unapproved, the script refuses to spend
   credits; the dry run makes at most the documented probe calls and performs no writes. The
   agent/dev never opens the gate.
7. **AC-7 (dry-run default).** Running the script with no flag performs NO DB writes and prints
   the per-game credit estimate; writes happen only with `--apply`.
8. **AC-8 (before/after counts).** `--apply` output shows before/after `Card` and
   `CurrentPrice` counts and created/updated/skipped/invalid tallies.
9. **AC-9 (set guard-rail).** After the re-ingest, no new `onepiece-<CODE>` (e.g.
   `onepiece-OP01`) phantom `CardSet` rows exist; One Piece set keys are the
   `onepiece-<slug>` form.
10. **AC-10 (zero owned-row loss).** Before/after counts of `UserCollection` are equal (none
    lost); every pre-migration `UserCollection.cardId` still resolves to an existing `Card.id`
    after migration.
11. **AC-11 (base printing preserved in place).** For a migrated multi-printing number, the
    base/normal printing occupies the PRE-EXISTING `Card.id` (owned rows did not move), and the
    other printings are NEW rows.
12. **AC-12 (guarded deletes only).** No `Card`/`CardSet` row with any owned `UserCollection`
    reference is deleted; any delete performed is proven `count = 0` owned references first and
    is reflected in before/after counts.
13. **AC-13 (per-set transactional / recoverable).** A forced failure mid-migration leaves the
    catalog consistent (no half-migrated set); the operation is resumable or rolled back.
14. **AC-14 (want-list resolves).** After migration, existing `WantListItem.cardId` values
    still resolve to a `Card` (the base printing for that number); no want-list row is orphaned.
15. **AC-15 (search parity — One Piece).** `GET /api/cards/search?game=onepiece&query=OP01-120`
    returns the distinct printings of Shanks as SEPARATE results, each with its own printing
    label, image, and price (or "—" when unpriced).
16. **AC-16 (search parity — Pokémon).** `GET /api/cards/search?game=pokemon&query=<sample>` for
    a chosen multi-printing Pokémon card returns reverse-holo/holo/normal (etc.) as SEPARATE,
    individually-priced results.
17. **AC-17 (per-printing price/image).** For a multi-printing result set, the printings show
    DIFFERENT prices/images where Scrydex has different values (e.g. foil vs alt-art), never a
    single shared value copied across them.
18. **AC-18 (filter-options unchanged).** `GET /api/cards/filter-options` returns the same set
    NAME and rarity option lists semantics as before (no per-printing duplication of options),
    for both games.
19. **AC-19 (distinct owned printings).** Adding "Alt Art Shanks" and "Foil Shanks" to a
    collection produces TWO distinct `UserCollection` rows (distinct `cardId`); the
    `uc_variant_coalesced` uniqueness still holds (a repeat add of the same printing+condition
    increments quantity rather than duplicating).
20. **AC-20 (grade dropdown unregressed).** The grade/condition dropdown on the add/detail flow
    still functions after the re-model; no regression of the PSA-8.5 concern is introduced
    (and that concern is not fixed here — out of scope).
21. **AC-21 (variantImages display path retired).** No UI path relies on `Card.variantImages`
    for variant identity or art after the change; per-printing art comes from each row's
    `imageUrl`.
22. **AC-22 (parity check available).** A parity check exists that, for a sample number in each
    game, asserts the app's per-printing result count/labels match Scrydex's `variants[]` for
    that number; its offline portion runs without credits and its live portion is credit-gated
    and owner-run.
23. **AC-23 (quality gate green).** `npm run type-check`, `npm run lint`, `npm run test:unit`,
    and `npm run test:integration` all pass; changed pure logic has at least one runnable test.
24. **AC-24 (no push / worktree only).** No commit to master and no push; all changes stay in
    the `scrydex-parity` worktree; scripts run via the Droplet one-off-container pattern.

---

## Out of Scope

- **Fixing the PSA-8.5 / invalid-graded-data concern** (FR-4.5 only requires NOT regressing it).
- **The quantity-doubling add bug** (`isSold`/add-to-collection quantity) from the user thread —
  a separate issue, not this catalog re-model.
- **Re-running or redesigning `scripts/reconcile-onepiece-sets.ts`** (set-dedup, already on
  master) — only its guard-rail is applied (FR-2.7) and its sequencing noted (FR-2.8).
- **New population/history/sold-listing cadence or scope** — those stay on their existing
  on-view 7-day cadence; this work does not change their schedule.
- **Language/currency/display features** beyond what the re-model requires for parity.
- **Opening the Scrydex credit gate or running the live paid pull** — the OWNER performs the
  gated dry-run then `--apply` (One Piece first, then Pokémon). The agent never spends credits.
- **Keyset pagination or other search-pagination changes** — offset pagination is retained
  (AGENTS.md rule 12).
- **Grouped/expandable search UI** (variants nested under a number) — the approved target is a
  FLAT list of distinct printings (Scrydex parity); a grouped view is a possible future option,
  not this scope.
