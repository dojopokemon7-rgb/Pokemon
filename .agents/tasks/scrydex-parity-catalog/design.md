# Technical Design — Full Scrydex-Parity Catalog Re-Model (both games)

> Companion to `requirements.md` (same folder) and `PLAN.md`
> (`.agents/tasks/scrydex-parity-catalog/PLAN.md` at the repo root). This design makes the
> concrete, implementable decisions the requirements left open. The technology stack is
> locked by AGENTS.md (Next.js 15 / React 19 / Prisma 6 / PostgreSQL-Supabase / Zod 3 /
> Vitest + Playwright) and is NOT re-opened here.
>
> **Revision 2** — a `design-review.json` (verdict `CHANGES_REQUESTED`, 2 HIGH + 3 MEDIUM)
> was present. Every finding is resolved in-line below and recorded in the
> "Responses to design-review findings" section at the end. The load-bearing change this
> revision made: the Pokémon base-printing reconciliation is now **MATCH-THEN-UPSERT on a
> scheme-independent identity** (not blind-upsert-on-the-Scrydex-id), because the review
> correctly caught that Scrydex's Pokémon `card.id` (`me55c-4`) is NOT the existing Pokémon
> `Card.externalId` (`base1-4`) — verified below with real source evidence.
>
> **Revision 3** — a second `design-review.json` (verdict `CHANGES_REQUESTED`, 2 MEDIUM + 4 NIT)
> reviewed Revision 2. Every finding is resolved in-line below and recorded in the "Responses to
> design-review findings (Revision 3)" section at the end. The two load-bearing changes: (1) the
> per-printing image now falls back to the base card art for EVERY printing (not just the base),
> so an imageless alt/reverse printing becomes a row instead of being dropped (MEDIUM-1); and
> (2) the add-to-collection new-card fallback strips the `::<variant>` suffix before deriving
> `number`, so a composite id can never corrupt `Card.number` (MEDIUM-2). The Pokémon base match
> is tightened to match on SET NAME (not raw `setId`) with a mandatory owner pre-check (NIT-3).
>
> **Note on `PLAN.md` location (MEDIUM-3):** `PLAN.md` lives at the REPO ROOT
> (`d:\Pokemon\Pokemon\.agents\tasks\scrydex-parity-catalog\PLAN.md`), NOT in the worktree
> task folder. A fresh implementer working inside the worktree must read it at the repo-root
> path. (The owner may copy it into the worktree task folder; this design cites the repo-root
> path to be unambiguous.)

---

## 0. Overview

The Dojo catalog collapses every printing of a card number into a single `Card` row and
demotes the alternate printings to a display-only `Card.variantImages` JSON map (one row, one
price, one search result). Scrydex returns every printing nested in each catalog card's
`variants[]` array. The goal is Scrydex parity: **one `Card` row per `variants[]` entry**, for
BOTH One Piece and Pokémon, each printing searchable, ownable, and individually priced.

The change is almost entirely in the **ingest mappers** plus a **small, additive schema
change** and a **one-off reconciliation script** that the OWNER runs (gated, dry-run default).
No search-pagination rewrite, no new runtime services, no new dependency. The crux — proven
below with the real Scrydex response shape — is that **Scrydex does NOT give each printing a
distinct top-level `card.id`**, so the per-printing key is a deterministic composite
`externalId = "${card.id}::${variantName}"`. `Card.number` stays the Bandai code (non-unique),
`Card.variantImages` is retired as the variant mechanism, and a new `Card.printing` label
column carries `variants[].name`.

The phases below are ordered so each is independently verifiable, the catalog is never left
half-migrated, and every credit-spending Scrydex call passes the DENY-by-default credit gate.

---

## 1. THE PER-PRINTING UNIQUE KEY — decision + evidence

### 1.1 Verdict

**Printings SHARE a single top-level `card.id`; they differ only by `variants[].name`.
Therefore the per-printing key is a deterministic composite built on a BASE id plus a variant
suffix:**

```
Card.externalId = base printing → <baseId>                 // the EXISTING row's externalId, verbatim
                  non-base      → `${baseId}::${variantName}`   // e.g. "OP01-120::alt-art", "base1-4::reverse holofoil"
```

where `variantName = (variant.name || "normal")` (the `VariantSchema.name` default is already
`"normal"`), `baseVariantName` is the deterministic base selector (§4.1), and — CRUCIALLY —
**`baseId` is NOT blindly the Scrydex `card.id`.** `baseId` is the id the EXISTING collapsed row
already holds for that physical card, resolved by a match step (§5.1). This differs by game:

- **One Piece:** the Scrydex `card.id` IS the Bandai code (e.g. `OP01-120`) and IS already the
  existing `Card.externalId` (proven below, evidence #4). So for OP, `baseId == card.id` and the
  base printing upserts onto the existing row with no extra matching needed.
- **Pokémon:** the Scrydex `card.id` is the Scrydex-NATIVE id (e.g. `me55c-4`) and is NOT the
  existing `Card.externalId`, which is the pokemontcg.io / TCGdex id (e.g. `base1-4`) — proven
  below (evidence #4). So for Pokémon, `baseId` MUST be resolved to the existing row's
  `externalId` by a scheme-independent match (scrydexId, else number+setId) — NOT taken from
  `card.id`. The base printing then upserts onto that found row's existing `externalId`
  (`base1-4`), and only the NON-base printings get the `::<variant>` suffix
  (`base1-4::reverse holofoil`). This preserves owned FKs and want-list ids regardless of which
  id scheme the existing Pokémon rows use.

This is the key insight that makes the migration safe AND back-compatible for BOTH games: the
*base* printing lands on the existing row's `externalId` unchanged (match-then-upsert, §5.1);
only the *additional* printings are new rows with `::<variant>`-suffixed ids. A green-field row
(no existing match) uses `baseId = card.id` for its base printing (One Piece style) — correct
because there is nothing to preserve.

### 1.2 Evidence (from the real Scrydex response shape)

Four independent pieces of evidence, all inspected directly (the 4th added in Revision 2 to
settle the Pokémon identity question the review raised):

1. **The Zod schema models ONE `id` per card with printings nested in `variants[]`.** In
   `src/lib/services/scrydex.service.ts`:
   ```ts
   const VariantSchema = z.object({
     name: z.string().default("normal"),
     prices: z.array(PriceEntrySchema).default([]),
     images: ScrydexImageSchema,
   });
   const ScrydexCardSchema = z.object({
     id: z.string(),            // ONE id per card
     name: z.string(),
     number: z.string().nullish(),
     ...
     images: ScrydexImageSchema,
     variants: z.array(VariantSchema).default([]),   // printings live HERE
   });
   ```
   Each catalog card has a single `id`; the Foil / Alt Art / Manga / Reprint printings are the
   entries of `variants[]`, each with its own `name`, `prices[]`, and `images[]`. There is NO
   per-variant `id` field in the schema — so Scrydex does not hand us a distinct top-level id
   per printing. Reusing `Card.externalId = card.id` verbatim therefore **cannot** uniquely key
   a printing (all printings of OP01-120 would collide on the same `card.id`).

2. **The cached full-pull logs confirm `total_count` is ~1 entry per Bandai number, not per
   printing.** `.full-pull-onepiece.log` shows `total_count = 2840` for One Piece and the pull
   ingested 2,640 cards; `.full-pull.log` / `.full-pull-pokemon.log` show `total_count = 47481`
   for Pokémon. Prod currently holds ~2,897 OP + ~50,559 PKM rows — i.e. the catalog-list
   endpoint already maps ~1:1 to today's one-row-per-number rows. If each printing were its own
   top-level `card.id`, these totals would be multiples larger; they are not. The printings are
   therefore inside `variants[]`, exactly as the schema shows. (The owner's reported "125
   results" for OP01-120 is a Scrydex *dashboard* figure that fans out across variants + cross-
   set reprints + languages + graded listings; it is NOT 125 distinct catalog `card.id`s, and is
   not relied on here.)

3. **The current ingest already receives and then collapses the nested variants.** In
   `scripts/ingest-onepiece-catalog.ts`, `mapScrydexCatalogCard` emits exactly ONE
   `MappedOnePieceCard` per `card.id` (`externalId = card.id`) and calls `pickVariantImages(card)`
   to fold every `variants[]` entry's art into ONE JSON map on that single row. In
   `scripts/pull-full-catalog.ts`, `buildCardRow` emits one row per `c.id` and `buildPriceRows`
   flattens `c.variants[].prices[]` onto that one card. Both prove the per-printing data arrives
   in the same page payload and is collapsed at map time — not fetched separately.

4. **The two games use DIFFERENT id namespaces for `Card.externalId` — this is the fact that
   forces match-then-upsert for Pokémon (resolves review HIGH-1/HIGH-2).**
   - **One Piece:** `ingest-onepiece-catalog.ts` sets `externalId = card.id` and
     `number = deriveStoredCardNumber(card.id, true)` which, via `isOnePieceCode` (matches
     `OP|ST|EB|PRB` + digit), returns the FULL Bandai code. So the OP Scrydex `card.id` IS the
     Bandai code `OP01-120` AND IS the existing `Card.externalId`. Verified in
     `src/lib/utils/card-number.ts` + `ingest-onepiece-catalog.ts`.
   - **Pokémon:** `prisma/schema.prisma` states verbatim on `Card.scrydexId`: *"Scrydex-native
     card id (e.g. `me55c-4`) … Distinct from externalId (TCGdex id / Bandai code) — Scrydex uses
     its OWN id namespace."* `src/lib/services/scrydex.service.ts` repeats it:
     `ScrydexCardSchema.id` is the *"Scrydex-native id (`me55c-4`), NOT the TCGdex externalId"*,
     and `resolveScrydexCard` exists precisely because `externalId` cannot be passed to the by-id
     endpoint. The EXISTING Pokémon rows were seeded via `prisma/seed.ts → searchPokemonCards`,
     whose primary source `fetchPokemonTcg` (pokemontcg.io) sets `id = c.id` = a pokemontcg.io id
     like `base1-4` (TCGdex fallback `fetchTcgdex` likewise). The add-to-collection route's own
     comment confirms it: *"Pokémon ids (`base1-4`)"*. Meanwhile the Pokémon pull script
     `pull-full-catalog.ts` writes `externalId: c.id, scrydexId: c.id` = the Scrydex native
     `me55c-4`. **Therefore the current Pokémon `Card.externalId` is `base1-4`-style (seed) and
     the Scrydex catalog `card.id` is `me55c-4`-style — they are DIFFERENT, so keying the base
     printing on bare `card.id` would NOT upsert onto the existing row; it would orphan the owned
     row and create a duplicate.** This is the exact failure the review flagged; §5.1 resolves it
     with match-then-upsert.

   > **MANDATORY read-only pre-check the OWNER runs before `--apply` on Pokémon** (no credits,
   > Droplet one-off pattern, PLAN.md §6) to pin the current Pokémon scheme empirically. This is
   > REQUIRED (not optional) per NIT-3: the match-then-upsert handles both schemes, but a clean
   > step-2 miss would silently green-field a seed row, and only this pre-check (plus the
   > set-NAME match in §5.1) makes the branch deterministic for a destructive-risk migration:
   > ```sql
   > SELECT "externalId", "scrydexId",
   >        ("externalId" = "scrydexId") AS ext_eq_scrydex
   > FROM "card" WHERE game = 'POKEMON' LIMIT 20;
   > SELECT count(*) AS total,
   >        count(*) FILTER (WHERE "externalId" = "scrydexId") AS ext_eq_scrydex,
   >        count(*) FILTER (WHERE "scrydexId" IS NULL)        AS scrydexid_null
   > FROM "card" WHERE game = 'POKEMON';
   > ```
   > If `ext_eq_scrydex` ≈ total → existing rows are Scrydex-pulled (`me55c-4`), and the match
   > step finds them by `scrydexId`. If `ext_eq_scrydex` ≈ 0 and most `externalId` are
   > `base1-4`-style → seeded rows, and the match step finds them by `number + setId`. The
   > migration branch (§5.1) handles BOTH; the query only tells the owner which branch will fire.

**Conclusion:** the composite key is REQUIRED (assumption A1 is confirmed as fact). The
re-ingest is a pure mapping change — emit one row per `variants[]` entry — that multiplies ROWS,
not PAGES, and therefore costs the SAME ~504 Scrydex credits as the original pull (NFR-1).

### 1.3 Why a composite `externalId` and not a new column

`Card.externalId` is already `@unique` and is the identity that flows to the client as
`NormalizedCard.id` and is consumed EVERYWHERE downstream as the card key:
- search/trending return it as `id`;
- the detail route `/api/cards/[id]/prices` looks up `where: { externalId: id }`;
- add-to-collection resolves `where: { OR: [{ externalId }, { id }] }`;
- `WantListItem.cardId` stores this external id (not a FK).

Making the composite the `externalId` means every one of these paths works UNCHANGED with
per-printing rows — a non-base printing simply has `id = "OP01-120::alt-art"` (or
`"base1-4::reverse holofoil"` for Pokémon) and resolves through the identical lookups.
Introducing a *separate* new key column would instead require touching every one of those call
sites to switch lookups, a far larger and riskier diff. The composite-on-`externalId` choice is
the minimal, correct one, AND it is what lets the base printing keep the existing row's
`externalId` verbatim (so owned FKs and want-list ids survive) — the `baseId` in the composite is
the EXISTING row's id, not necessarily the Scrydex `card.id` (§1.1, §5.1).

`Card.scrydexId` (nullable `@unique`) must then be relaxed to NON-unique (§2/§3), because all
printings of a number share the same Scrydex id and would otherwise collide on `scrydexId`. Note
`scrydexId` is ALSO the match key for the Pokémon reconciliation (§5.1) when it is populated — so
the migration keeps writing `scrydexId = card.id` on every printing (the Scrydex native id), now
as a non-unique indexed column.

---

## 2. Schema model — fields & constraints

Changes to `prisma/schema.prisma`, `model Card`:

| Field | Change | Rationale |
|---|---|---|
| `externalId String @unique` | **UNCHANGED** as a column; semantics change to the composite (`${scrydexId}::${variant}` for non-base, bare id for base). | Already `@unique`; the per-printing key rides it (§1.3). |
| `printing String?` | **ADD** — nullable string, verbatim `variants[].name` (default `"normal"` from the Zod schema when Scrydex omits a name). | FR-1.2 printing label. Nullable so the migration backfills existing rows to `"normal"` without a NOT NULL default fight; new ingest always writes it. |
| `scrydexId String? @unique` | **DROP the `@unique`** (keep the column, keep nullable). | FR-1.1/§1.3 — all printings of a number share one Scrydex id; a unique `scrydexId` would reject the 2nd+ printing. Replace with a plain `@@index([scrydexId])` for the resolve-cache lookup. |
| `number String` | **UNCHANGED, stays NON-unique.** | FR-1.3. Confirmed below there is NO uniqueness on `number` to drop. `deriveStoredCardNumber` behaviour preserved (OP = full Bandai code; PKM = tail). |
| `game Game @default(POKEMON)` | **UNCHANGED.** | FR-1.4. OP ingest sets `ONE_PIECE` explicitly (already does). |
| `variantImages Json?` | **KEPT nullable for back-compat; RETIRED as the variant mechanism.** No new write path populates it; the single remaining writer (`scrydex-pricing.service.ts` §4b) is removed/neutered (§6). | FR-1.5 / FR-4.6. |

**Confirmed: there is NO existing uniqueness on `number` to drop.** `model Card` declares only
`externalId @unique`, `scrydexId @unique`, and the `@@index` set (`setId`, `name`, `updatedAt`,
`tags` GIN). `number` carries no `@unique` and no `@@unique`, so nothing must be dropped for it
(AC-3). The only uniqueness being *removed* is on `scrydexId`.

**Pricing keys are untouched and remain valid (FR-1.7).** `CurrentPrice` /`PricingHistory` are
keyed by `cardId` (the internal cuid) plus
`(source, currency, variant, condition, company, grade, type)`. With per-printing rows, each
printing is its own `cardId`, and the price rows for that printing attach to it. Because each
printing row now carries ONLY its own `variants[i].prices[]` (not the flattened union of all
variants), no new collision is possible — the uniqueness tuple stays valid and keeps its full
variant/condition/company/grade/type discrimination. (Note: the price-row `variant` column stays
equal to the Scrydex `variant.name`, i.e. the SAME value as the row's `printing` label — this is
intentional redundancy that keeps the price writer and the chart/detail `listVariants` path
unchanged.)

---

## 3. The Prisma migration

One additive migration under `prisma/migrations/`, applied with the pinned v6 CLI
(`npx -y prisma@6 migrate deploy`, PLAN.md §6). Name:
`<timestamp>_card_per_printing_model`.

```sql
-- 1. Printing label (FR-1.2). Nullable; backfilled to 'normal' for existing rows so
--    the pre-migration collapsed rows read as the base/normal printing.
ALTER TABLE "card" ADD COLUMN "printing" TEXT;
UPDATE "card" SET "printing" = 'normal' WHERE "printing" IS NULL;

-- 2. Relax scrydexId uniqueness (FR-1.1/§1.3) — printings share one Scrydex id.
--    Prisma named the unique index "card_scrydexId_key"; drop it, add a plain index.
DROP INDEX IF EXISTS "card_scrydexId_key";
CREATE INDEX IF NOT EXISTS "card_scrydexId_idx" ON "card" ("scrydexId");

-- 3. (No change to "number": it has NO uniqueness to drop — verified.)
-- 4. (No change to "externalId": it STAYS @unique; the composite value rides it.)
-- 5. ("variantImages" column is KEPT as-is for back-compat; no DDL.)
```

The corresponding `schema.prisma` edits: add `printing String?`; change
`scrydexId String? @unique` → `scrydexId String?` and add `@@index([scrydexId])`. Run
`npx -y prisma@6 generate` after. The migration is purely additive + an index swap — it does NOT
touch data beyond the one-time `printing='normal'` backfill, so it is safe to apply before the
re-ingest (the re-ingest then overwrites `printing` per printing).

> **pg_trgm note:** the existing raw-SQL trigram indexes (`card_name_trgm_idx`,
> `card_number_trgm_idx`) are unaffected — they index `name`/`number`, which do not change shape.
> No new trigram index is needed for `externalId` (it is matched by `startsWith`/`equals`, which
> the btree `@unique` serves).

---

## 4. Ingest rewrite — both games (one Card row per variant)

The two mappers are rewritten to emit one row per `variants[]` entry. A shared pure helper
decides the base printing so the two paths agree.

### 4.1 Shared base-printing rule (deterministic, documented — FR-3.2)

Add to `src/lib/utils/card-number.ts` (pure, unit-tested):

```ts
/** The base/normal printing of a Scrydex card. ORDER-INDEPENDENT (resolves
 *  review MEDIUM-1): the variant named "normal" (case-insensitive) if present,
 *  else the lexicographically-smallest variant.name (a deterministic TOTAL
 *  order on a stable field, NOT array position) — so a re-ingest that reorders
 *  variants[] still picks the same base. */
export function baseVariantName(variantNames: string[]): string {
  const names = variantNames.map((n) => n || "normal");
  const normal = names.find((n) => n.toLowerCase() === "normal");
  if (normal) return normal;
  // No "normal" → deterministic total order, independent of Scrydex array order.
  return [...names].sort((a, b) => a.localeCompare(b, "en"))[0] ?? "normal";
}

/** Per-printing externalId: the base printing keeps `baseId` verbatim (the
 *  EXISTING row's externalId, §5.1 — NOT necessarily the Scrydex card.id),
 *  every other printing is `${baseId}::${variantName}`. Stable across
 *  re-ingests → idempotent upsert. */
export function printingExternalId(baseId: string, variantName: string, baseName: string): string {
  return variantName === baseName ? baseId : `${baseId}::${variantName}`;
}
```

Rationale for "normal else lexicographically-smallest": the current collapsed row's price
headline comes from `pickRawPrice`, which already prefers the `normal` variant's NM price; keeping
the base printing = the `normal` variant means the preserved existing row keeps the same headline
price it has today, minimising observable change for owned/want-list rows mapped onto it. The
"else lexicographically-smallest name" branch (rather than "else first in array") is REQUIRED for
idempotency (FR-2.3 / AC-5) and base-preservation (FR-3.2 / AC-11) because Scrydex does not
document a stable `variants[]` array order: a re-ingest that reordered the array for a
`normal`-less number (alt-art/promo-only) would otherwise flip which printing takes the base id.
A total order on `variant.name` is stable across re-ingests regardless of array order. Unit-tested
by feeding the same variants in two orders and asserting identical externalIds (§8.1).

### 4.2 One Piece — `scripts/ingest-onepiece-catalog.ts`

- `mapScrydexCatalogCard(card)` → returns `MappedOnePieceCard[]` (one per variant), not a single
  object. For One Piece `baseId = card.id` directly (the Bandai code IS the existing externalId —
  evidence #4, no match step needed). For each `variant` of `card.variants`:
  - `externalId = printingExternalId(card.id, variant.name, base)`;
  - `number = deriveStoredCardNumber(card.id, true)` — UNCHANGED (full Bandai code, non-unique,
    shared across the number's printings);
  - `printing = variant.name || "normal"`;
  - `imageUrl = pickImageEntry(variant.images) ?? pickBaseImageUrl(card)` — prefer the
    printing's OWN art (large→medium→small), but fall back to the base card image for EVERY
    printing, not just the base (MEDIUM-1). `pickBaseImageUrl(card)` is a tiny new helper (or
    `pickImageEntry(card.images)?.large ?? …?.medium ?? …?.small ?? null` inlined) reading the
    TOP-LEVEL `card.images` — the existing `pickImageEntry` already handles the `.nullish()`
    array; only the `??`-to-base chaining is new. Scrydex marks `VariantSchema.images` `.nullish()`
    precisely because a variant can lack its own art; the base card image is still a REAL
    Scrydex image for that physical card, so using it for an imageless alt/reverse printing is
    honest (NOT fabrication — it is the same base art today's collapsed row shows). A printing
    is dropped as invalid (below) ONLY when the base card ALSO has no usable image (a genuinely
    imageless card, dropped today too);
  - price rows from `variant.prices[]` (this printing's own prices only);
  - still validate each mapped printing through `NormalizedCardSchema` (RULE 4); a printing with
    no set name / empty name is DROPPED and counted `invalid` (FR-2.2, RULE 2). After the
    base-image fallback above, a printing fails the image refine ONLY when the base card is
    itself imageless — so an imageless alt/reverse printing is NOT dropped, it carries the base
    art (MEDIUM-1).
- `upsertOnePieceCard(m)` is keyed on `where: { externalId: m.externalId }` (the composite), sets
  `game: ONE_PIECE` explicitly, writes `printing`, and writes that printing's `CurrentPrice`
  rows. `variantImages` is NO LONGER written (FR-1.5). **The rewrite must ALSO remove the two
  existing `variantImages`-specific pieces of `upsertOnePieceCard` (NIT-4):** (1) the
  `...(hasVariantImages ? { variantImages: m.variantImages } : {})` write branch in its `base`
  object, and (2) the `(!hasVariantImages || canonical(prior.variantImages) ===
  canonical(m.variantImages))` term in its `unchanged` comparison (and the now-dead
  `hasVariantImages`/`canonical`/`VariantImageMap` locals). Replace the dropped unchanged term
  with a `prior.printing === m.printing` equality so idempotency (AC-5) is preserved on the NEW
  per-printing field instead of the retired `variantImages`. Leaving the `canonical(variantImages)`
  term in place against a mapper that no longer writes `variantImages` would mis-classify
  changed/skipped on a re-run. Idempotent: a re-run compares the stored row and reports `skipped`
  when unchanged (FR-2.3 / AC-5).
- Set key: UNCHANGED — `onePieceSetExternalId(setName)` (the `onepiece-<slug>` guard-rail,
  FR-2.7) continues to key the set from the NAME, so the re-ingest can never recreate the phantom
  `onepiece-OP01` CODE rows.

### 4.3 Pokémon — `scripts/pull-full-catalog.ts`

**Provenance note (must be resolved first — MEDIUM-3):** `pull-full-catalog.ts` exists in the
repo root working tree (`d:\Pokemon\Pokemon\scripts\pull-full-catalog.ts`) but is NOT present on
the `scrydex-parity` worktree branch. Before the Pokémon rewrite, copy the CURRENT repo-root
version onto the worktree branch so the edit lands there. Do NOT reinvent it.

**The current master `pull-full-catalog.ts` has NO credit gate, NO dry-run, and NO `--apply`**
(verified: a bare `main()` that pages and `createMany`s immediately). FR-2.4/2.5/AC-6/AC-7 depend
on these, so the rewrite must ADD them — it is NOT "extending" an existing contract (there is
none). Specifically ADD, matching the One Piece script's contract:
`assertScrydexCreditsApproved("standard", pages)` before any live fetch; a dry-run DEFAULT (one
gated page-1 fetch → print `total_count` + sample + credit estimate, NO writes); the `--apply`
flag to perform writes; and before/after `Card`+`CurrentPrice` count reporting.

**Idempotency/resume primitive changes (NIT-2).** The current script's only resume story is the
`START_PAGE`/`MAX_PAGES` env knobs plus `createMany({ skipDuplicates: true })`. The rewrite
REPLACES `createMany skipDuplicates` with the per-set transactional match-then-upsert loop
(§5.4) as the idempotency/resume mechanism — that loop (not `skipDuplicates`) is now what makes
a re-run skip unchanged printings and resume after a committed set. `START_PAGE`/`MAX_PAGES`
remain ONLY as coarse manual knobs for a human operator; they are not the correctness mechanism.
The DB-identity print is kept.

**Match-then-upsert (resolves HIGH-1/HIGH-2).** Because the existing Pokémon `externalId` is
`base1-4`-style and the Scrydex `card.id` is `me55c-4`-style (evidence #4), the Pokémon path must
NOT key the base printing on `card.id`. For each Scrydex card `c`:
1. Resolve `baseId` by finding the pre-existing collapsed row via a scheme-independent identity,
   in priority order: (a) `scrydexId == c.id` if any row has it populated; else (b)
   `number + SET NAME` (match on `game` + `set.name` + the same `normNumber`/tail logic the
   existing `resolveScrydexCard` path uses, so `base1-4` → `4` matches `c.number = "4"` under the
   matching expansion name). The match is on the set NAME, NOT the raw `setId`, because seeded
   Pokémon rows and Scrydex-keyed sets can be DIFFERENT `CardSet` rows (NIT-3, see §5.1). If a row
   is found, `baseId = foundRow.externalId` (verbatim — e.g. `base1-4`). If NO row is found
   (genuinely new card), `baseId = c.id` (green-field, nothing to preserve).
2. `base = baseVariantName(c.variants.map(v => v.name))` (order-independent, §4.1).
3. Emit one row per `variant`: `externalId = printingExternalId(baseId, variant.name, base)` —
   so the base printing reuses the found row's `externalId` and non-base printings are
   `${baseId}::${variant}`.

Rewrite shape:
- `buildCardRow(c, setId, game)` → `buildCardRows(c, setId, game, baseId): Row[]` — one row per
  `c.variants[]` entry. Each row: `externalId = printingExternalId(baseId, variant.name, base)`,
  `scrydexId = c.id` (now non-unique — kept so future runs can match by it), `number = c.number ??
  ""` (UNCHANGED), `printing = variant.name || "normal"`, `imageUrl/imageUrlHi` from
  `pickImageEntry(variant.images) ?? pickBaseImageUrl(c)` — the per-variant art preferred, the
  base card image as the fallback for EVERY printing (MEDIUM-1, same rule as One Piece §4.2),
  `marketPrice`/`weeklyChange*` from THIS variant's NM-raw entry + its `trends.days_7`.
- `buildPriceRows(c, cardId)` → `buildPriceRows(variant, cardId)` — scoped to a SINGLE variant's
  `prices[]` (this printing's own rows), keeping the existing per-row dedupe tuple.
- The page loop does the resolve-then-upsert per card. Because the base printing's `externalId`
  is the found row's existing id, a plain `createMany({ skipDuplicates: true })` would SKIP the
  base (it already exists) and only INSERT the non-base `::` rows — which is almost right but
  would leave the base row's `printing`/`scrydexId` columns un-backfilled. So the Pokémon path
  switches to an explicit per-card upsert loop (like the OP script): `update` the matched base row
  (set `printing`, `scrydexId`, refreshed price fields) and `create` the non-base printings. This
  keeps it idempotent on the composite `externalId` (a re-run skips unchanged printings). Pokémon
  set key stays `exp.id`-based (FR-2.7 — unaffected).

### 4.4 Dry-run default + `--apply` + before/after counts (FR-2.4–2.6)

The One Piece script ALREADY has this contract; the Pokémon script does NOT and must have it
ADDED (MEDIUM-3). After the rewrite BOTH follow the identical contract: no flag = DRY RUN (one
gated page-1 fetch, print `total_count`, a sample, and the per-game credit estimate, NO writes).
`--apply` = full paged ingest. Every credit-spending call passes `assertScrydexCreditsApproved("standard", pages)`
(DENY by default). `--apply` prints before/after `Card` and `CurrentPrice` counts plus the
`IngestReport` created/updated/skipped/invalid tallies. The agent/dev NEVER opens the gate or
runs a paid pull — the OWNER does.

---

## 5. Data migration / reconciliation (zero data loss)

The re-ingest IS the migration: its upserts preserve the base printing on the existing row and
add the others as new rows. A thin reconciliation wrapper handles verification and the guarded
exceptional delete. This is delivered as one owner-run script (§7),
`scripts/reingest-per-printing.ts`, that drives the two mappers per game.

### 5.1 Base printing MATCH-THEN-UPSERT onto the existing row (FR-3.2, AC-11 — resolves HIGH-1/HIGH-2)

The migration does NOT blind-upsert the base printing on the Scrydex `card.id`. It MATCHES the
pre-existing collapsed row by a scheme-independent identity first, then upserts the base printing
onto THAT row's existing `externalId`:

```
baseId(c, setName):
  1. row = findFirst(where scrydexId == c.id)                       // Scrydex-pulled rows
  2. else row = findFirst(where game == G                           // seeded rows: number + SET NAME
                          AND set.name == setName
                          AND numberMatches(c.number))              //   (mirrors resolveScrydexCard)
  3. return row ? row.externalId : c.id                             // reuse existing id, else green-field
```

- **One Piece:** step 1/2 find the row whose `externalId == card.id` (the Bandai code is both),
  so `baseId = externalId = card.id`. Works as before.
- **Pokémon (the fix):** step 1 finds the row by `scrydexId` IF the catalog was previously pulled
  via `pull-full-catalog.ts` (which wrote `scrydexId = c.id`); otherwise step 2 finds the SEEDED
  row (`externalId = base1-4`) by `number + SET NAME` — matching on the set NAME, NOT the raw
  `setId`, because the seeded Pokémon rows' `setId` points at a `CardSet` keyed by the
  TCGdex/pokemontcg.io id while the re-ingest upserts sets keyed by `pokemon-<exp.id>` (Scrydex);
  a raw `setId` equality could reference DIFFERENT `CardSet` rows and MISS, falling through to
  green-field `baseId = c.id` and silently orphaning the owned row. Matching on `game` +
  `set.name` + the same `normNumber`/tail logic mirrors `resolveScrydexCard`'s `expansion.name`
  match and is scheme-independent (NIT-3). Either way `baseId = foundRow.externalId` (`base1-4`,
  verbatim), so the base printing upserts ONTO the existing row. Its `Card.id` (internal cuid) is
  UNCHANGED → every `UserCollection.cardId` FK is preserved untouched (FR-3.1/FR-3.3), and the
  want-list `cardId = "base1-4"` still resolves (§5.5).

  > **Determinism requirement (NIT-3).** Because a clean step-2 MISS creates a Scrydex-id base
  > instead of reusing the seed row — and the duplicate-base assertion (below) catches a DOUBLE
  > base but NOT a clean miss — the owner's read-only pre-check query in §1.2 is **MANDATORY, not
  > optional**, before `--apply` on Pokémon: it tells the owner whether existing Pokémon rows are
  > `scrydexId`-populated (step 1 fires) or seed-provenance `base1-4` (step 2 fires on set NAME).
  > If the pre-check reveals seed rows whose set names do NOT line up with the Scrydex expansion
  > names, Pokémon set reconciliation MUST precede the per-printing ingest (same ordering as the
  > OP set-dedup, §5.6). The set-NAME match + the mandatory pre-check together make the Pokémon
  > base resolution deterministic rather than "probably fine".

The non-base printings (`${baseId}::<variant>`) have new `externalId`s with no existing row, so
they are CREATED as new rows. No existing row is moved, re-pointed, or deleted.

**Duplicate-base guard (resolves HIGH-2).** Because the base printing keys on the FOUND row's
`externalId` (never a fresh `card.id` when a row exists), the "orphan old row + create duplicate
new base" failure the review flagged cannot occur. The migration ASSERTS this per set: after
each set's upserts, `COUNT(*)` of rows for that number+set whose `externalId` has NO `::` suffix
(i.e. base rows) MUST be exactly 1; and the per-set net `Card`-count increase MUST equal the
number of non-base printings created (never more). Either assertion failing rolls the set's
transaction back and halts loud (§5.4) — so a scheme mismatch can never silently duplicate.

### 5.2 Owned rows (FR-3.3, AC-10) and FK/cascade safety

`UserCollection.cardId` → `Card.id` (`onDelete: Cascade`). Because owned collapsed cards map onto
the preserved base-printing row (which keeps its `Card.id`), no owned row is orphaned, re-pointed,
or deleted. Before/after `UserCollection` counts are asserted equal (AC-10). The migration
performs NO delete on the normal path, so no `onDelete: Cascade` chain
(`Card→UserCollection/PricingHistory/CurrentPrice/PopulationReport/SoldListing`,
`CardSet→Card`) is ever triggered.

### 5.3 Guarded delete (FR-3.4, AC-12) — the exception, not the default

The normal path adds rows and never deletes. Because the base printing is upserted onto the
MATCHED existing row (§5.1), its `externalId` never changes, so no existing row is ever orphaned
by the re-model. Therefore in the expected path there are ZERO deletes. The script still ships a
GUARDED delete helper for the genuine edge case where a pre-existing row matches NO Scrydex card
at all (e.g. a catalog card Scrydex removed, or a stale seed row whose number+set no longer
exists in the catalog): delete it ONLY after a pre-check
`SELECT count(*) FROM user_collection WHERE "cardId" = $1` returns 0, and account for it in
before/after counts. If owned references exist, the row is KEPT and logged, never deleted.
(This helper is NOT invoked to resolve a scheme mismatch — §5.1's match step prevents the
mismatch entirely; the duplicate-base guard would halt before any such delete was considered.)

### 5.4 Per-set transactional / recoverable (FR-3.5, AC-13)

The re-ingest processes one set (one `CardSet`) at a time; each set's upserts run inside a
`prisma.$transaction`, with before/after `Card`+`CurrentPrice` counts logged per set. A failure
mid-set rolls that set back (no half-migrated set); already-committed sets stay done and the run
is resumable (re-running skips the completed sets via idempotent upserts). Preferred order:
staging-first if Scrydex credits allow (isolated `staging` schema), else per-set transactions
straight to prod — the OWNER decides based on credit budget (A5).

### 5.5 WantListItem resolution (FR-3.6, AC-14)

`WantListItem.cardId` stores the EXTERNAL id (Bandai code / catalog id), e.g. `OP01-120` or
`base1-4` — the BARE id. Because §5.1 preserves the EXISTING row's `externalId` as the base
printing's `externalId` for BOTH games (One Piece `OP01-120`, Pokémon `base1-4`), the want-list
`cardId` value is still exactly the base printing's `externalId` after the re-model. So every
existing want-list row — including Pokémon rows keyed on `base1-4` — still resolves to the base
printing's `Card`. This is the direct payoff of match-then-upsert: had the base printing been
re-keyed to `me55c-4`, Pokémon want-list rows would have silently broken (the review's HIGH-1
concern); they do not, because the base keeps `base1-4`. No want-list row is orphaned. (A
want-list entry maps to the base printing by definition, since it carries the bare number/id;
future UI could let a user want a specific `::variant`, but that is not required for parity and is
out of scope.)

### 5.6 Sequencing vs `reconcile-onepiece-sets.ts` (FR-2.8)

The already-landed set-dedup (`scripts/reconcile-onepiece-sets.ts`, commit `b3f1d52`) must run
BEFORE the per-printing re-ingest, so the OP catalog has exactly one canonical `onepiece-<slug>`
set per name first; the re-ingest then upserts printings onto those canonical sets (and the
`onePieceSetExternalId` guard-rail keeps it from recreating phantoms). The two do not fight: set
reconciliation moves `Card.setId` (never deletes a non-empty set), the re-ingest adds printing
rows — different axes.

---

## 6. UI changes — per-printing parity

The search/collection/detail layers already key everything on `externalId` = `NormalizedCard.id`,
so a composite id flows through them unchanged. The required changes are: (a) surface the printing
label, (b) ensure each printing is its own result with its own price/image, (c) retire the
`variantImages`-on-one-row display path.

### 6.1 Search — each printing is its own result (FR-4.1/4.2, AC-15/16/17)

`GET /api/cards/search` already `findMany`s `Card` rows and maps each to a `NormalizedCard`. With
per-printing rows, it returns each printing as its own result automatically — no query rewrite,
offset pagination retained (AGENTS.md §12, out-of-scope to change). Changes:
- Add `printing: true` to the `select` and surface it on the result envelope. The cleanest,
  back-compatible way is to **append the printing label to `number`-adjacent display** rather than
  change the locked `NormalizedCard` schema: add an OPTIONAL `printing: z.string().nullish()` to
  `NormalizedCardSchema` (additive, nullable → old cached blobs still validate as `null`), and set
  it from `r.printing`. The tile renders "Alt Art" / "Foil" next to the number when `printing` is
  present and not `"normal"`.
- `marketPrice` and `imageUrl` already come per-row (`pickHeadlineRaw(r.currentPrices) ??
  r.marketPrice` and `r.imageUrl`), so each printing shows ITS price/image; unpriced → `null` →
  "—" (RULE 2). Because each printing row now holds only its own variant's `CurrentPrice` rows,
  `pickHeadlineRaw` returns that printing's price, not a shared one (AC-17).

**Search-cache invalidation after `--apply` (resolves MEDIUM-2).** `GET /api/cards/search` caches
its catalog result in Redis under `RedisKeys.cardSearchResult(...)` → key prefix
`card:searchq:` with `CACHE_TTL.cardSearch = 300` (5 minutes, verified in `src/lib/redis.ts` —
NOT 24h; the 24h `card:search:` key is the service-layer EXTERNAL-search cache populated only on a
DB miss by `card.service.ts`, a different path the DB-backed catalog read does not use). Either
cache could still serve the OLD single collapsed result for a queried number during its TTL window
right after the owner runs `--apply`, so parity verification (AC-15/16) and users would briefly
see one result. **Decision: the re-ingest `--apply` step flushes the search caches at the end of
its run** — `redis.del` over `card:searchq:*` AND `card:search:*` (SCAN + UNLINK, best-effort,
wrapped in try/catch per RULE 1 so a Redis fault never fails the migration; Redis is a pure cache
and fully reconstructable). This is one bounded, deterministic action at the known mutation point,
cheaper than versioning the key (which would strand the old blobs until TTL anyway). If Redis is
absent (dev / optional), the flush is a no-op and the 5-minute TTL lapses on its own — acceptable.
The parity verify script (§8.3) additionally reads the DB directly (not through the cached route)
so its assertion is never tripped by a stale blob.

### 6.2 Filter-options unchanged (FR-4.3, AC-18)

`GET /api/cards/filter-options` lists DISTINCT `CardSet.name` and rarities. Per-printing rows do
NOT multiply distinct set names (sets are unchanged) and rarities are already de-duplicated. No
change; a test asserts the option-list semantics are unchanged after the re-model.

### 6.3 Add-to-collection keys per printing (FR-4.4, AC-19)

`POST /api/users/me/collection` resolves the card by `externalId`/`id` and keys a lot on
(`userId`, `collectionId`, `cardId`, `isFoil`, `condition`) via the `uc_variant_coalesced`
partial index. Because "Alt Art Shanks" (`OP01-120::alt-art`) and "Foil Shanks"
(`OP01-120::foil`) are now distinct `Card` rows with distinct `cardId`s, owning both yields TWO
distinct `UserCollection` rows automatically. The `uc_variant_coalesced`
uniqueness is UNCHANGED and MUST NOT be weakened; a repeat add of the same printing+condition
still increments quantity (AC-19, and the add-flow quantity bug is explicitly out of scope).

**New-card fallback `number` for a composite id (MEDIUM-2 — a written decision, not an
accident).** The POST resolves the card by `externalId` first and REUSES it when found, so on
the parity flow — where every printing is pre-created by the re-ingest — the composite id
already exists and the fallback is never reached. BUT the route has a genuine FALLBACK that
CREATES a new `Card` when the submitted `externalId` is absent from the catalog, computing
`number: deriveStoredCardNumber(item.externalId, isOnePieceCode(item.externalId))`. For a
composite id this would corrupt `number` (`"OP01-120::alt-art"` → `number "OP01-120::alt-art"`;
`"base1-4::reverse holofoil"` → tail → `number "4::reverse holofoil"`). **Decision: make the
fallback composite-safe with a one-line base split** — strip the `::<variant>` suffix before
deriving the number so the created row carries the correct Bandai/collector number:
```ts
const baseExt = item.externalId.split("::")[0]; // base id; no-op for non-composite ids
number: deriveStoredCardNumber(baseExt, isOnePieceCode(baseExt)),
```
This is a one-line change in `src/app/api/users/me/collection/route.ts` POST (the only site that
derives a number from a client-submitted externalId), is a no-op for today's non-composite ids,
and guarantees `number` is never a composite even on the rare stale-client / pre-re-ingest path.
It does NOT change `AddCardSchema` (the externalId is still just a non-empty string). The
printing label of such a fallback-created card is left at the schema default (`null`/"normal")
because a client submitting a bare composite without the catalog row carries no reliable
`variants[].name`; the authoritative label lands when the re-ingest upserts the real printing.

### 6.4 Retire the `variantImages` display path (FR-4.6, AC-21)

- **Detail page** (`src/app/(dashboard)/search/[id]/page.tsx`): the hero currently resolves the
  selected variant via `onePieceVariantImageUrl(variantImages, variant)`. With per-printing rows,
  the detail page for a specific printing (`id = "...::alt-art"`) already has THAT printing's own
  `imageUrl`, so the hero reads `imageUrl` directly. Remove the `variantImages`-based hero
  resolution and the `variantImages` field from the prices route payload consumer.
- **Prices route** (`src/app/api/cards/[id]/prices/route.ts`): drop `variantImages` from the
  payload + its cache schema (the cache schema change is a shape bump — old blobs fail re-parse →
  miss → live read, which is the intended behaviour).
- **Price writer** (`src/lib/services/scrydex-pricing.service.ts` §4b): remove the
  `pickVariantImages` write block (it is the last writer of `variantImages`). The column stays in
  the schema (nullable, back-compat) but nothing writes it.
- **Scanner / recognize** (`scanner/page.tsx`, `api/cards/recognize/route.ts`): these use
  `variantImages` for the on-device CLIP visual variant-disambiguation among printings that shared
  ONE row. With per-printing rows, the recognize route can instead return the distinct printing
  ROWS as candidates (each with its own `imageUrl`), which is strictly better and removes the
  `variantImages` dependency. **Scope guard-rail:** reworking the scanner's visual-match pipeline
  is larger than catalog parity; to keep this change bounded, the scanner's `variantImages` read is
  made defensively null-tolerant (it already is — `parseVariantImages` returns `{}` on null) so it
  degrades to single-image behaviour, and the per-printing-candidate rework is noted as a
  follow-up. `ponytail:` the scanner keeps a dormant `variantImages` read that now always sees
  `{}`; upgrade path = return distinct printing rows as candidates. No UI relies on `variantImages`
  for variant IDENTITY after this change (identity is the per-printing row) — satisfying AC-21.

### 6.5 Grade dropdown / PSA-8.5 not regressed (FR-4.5, AC-20)

The grade/condition dropdown reads `CurrentPrice`/graded rows by `cardId`; per-printing rows do
not change that path. The PSA-8.5 / invalid-graded concern is neither fixed nor regressed (it is
driven by graded-price selection, a separate path) — explicitly out of scope, only non-regression
is required.

---

## 7. The gated, dry-run-default re-ingest + migration script (owner-run)

One orchestrator, `scripts/reingest-per-printing.ts`, that the OWNER runs via the Droplet one-off
container pattern (PLAN.md §6). It wraps the two rewritten mappers and the reconciliation/verify
logic.

- **Guarded** by `scripts/_guard.ts` conventions + `assertScrydexCreditsApproved("standard",
  pages)` before ANY live page fetch (DENY by default). The agent never opens the gate.
- **Dry-run default:** no flag → read `total_count` per game (one gated page-1 fetch each), print
  the per-game credit estimate (OP ≈ 29, PKM ≈ 475), print before-counts, and a sample of the
  rows that WOULD be written (showing the composite externalIds + printing labels) — NO writes.
- **`--apply`:** runs the per-set transactional re-ingest (§5.4), game-scoped
  (`--game=onepiece|pokemon`, One Piece first per NFR/owner sequencing). For Pokémon it runs the
  match-then-upsert `baseId` resolution per card (§5.1). It prints before/after
  `Card`+`CurrentPrice`+`UserCollection` counts and the created/updated/skipped/invalid tallies,
  enforces the per-set duplicate-base + net-increase assertions (§5.1), runs the guarded-delete
  audit (expected: 0 deletes), and at the END flushes the search caches (`card:searchq:*` +
  `card:search:*`, best-effort, §6.1) so post-apply reads repopulate with the per-printing rows.
- **Droplet one-off container** (PLAN.md §6): mount `scripts/`, `src/`, `prisma/` into the
  standalone app image, pass `DATABASE_URL`/`DIRECT_URL`, run with `npx -y tsx`; Prisma CLI pinned
  to v6. Quote the space in the repo path on the Windows host when preparing the run.
- **No push / no commit to master** (NFR-7, AC-24) — all work stays in the `scrydex-parity`
  worktree.

---

## 8. Parity acceptance test design (both games)

Split into an offline portion (no credits, runs in `npm run verify`) and a live portion
(credit-gated, owner-run).

### 8.1 Unit tests (pure, no DB/network — NFR-5, AC-23)

In `tests/unit/`:
- `card-number` additions: `baseVariantName(["normal","foil"]) === "normal"`;
  `baseVariantName(["foil","alt art"]) === "alt art"` (lexicographically-smallest when no
  "normal"); **order-independence (MEDIUM-1):** `baseVariantName(["foil","alt art"]) ===
  baseVariantName(["alt art","foil"])` (same result regardless of array order);
  `printingExternalId("base1-4","normal","normal") === "base1-4"` (base keeps the EXISTING id,
  not the Scrydex id); `printingExternalId("base1-4","reverse holofoil","normal") ===
  "base1-4::reverse holofoil"`.
- Mapper tests (importing the pure mapper seam, NOT the live runner, exactly as the existing
  `ingest-onepiece-catalog` test does): feed a fixture Scrydex card with 3 variants → assert the
  mapper emits 3 rows with distinct composite externalIds, each carrying its own `printing`,
  `imageUrl`, and price rows.
- **Image fallback (MEDIUM-1):** a 3-variant card where ONE variant has empty/absent `images`
  but the base card HAS an image → assert the mapper emits **3 rows** (not 2), the imageless
  variant's row carrying the BASE card art (`imageUrl === pickBaseImageUrl(card)`), none dropped.
  A separate case where the base card ITSELF has no usable image → that printing IS dropped and
  counted `invalid` (an empty-set variant is likewise dropped).

### 8.2 Integration tests (mocked Prisma — AC-18/19)

In `tests/integration/`:
- **Pokémon base-id reuse (match-then-upsert, HIGH-1/HIGH-2):** seed one existing collapsed row
  with `externalId="base1-4"`, `scrydexId=null` (the seeded-provenance case), then run the
  Pokémon mapper over a Scrydex card `{ id:"me55c-4", number:"4", variants:[normal, reverse
  holofoil] }` for the same set; assert the base printing's row keeps `externalId="base1-4"` (NOT
  `me55c-4`) and the non-base printing is `base1-4::reverse holofoil` — i.e. the owned/want-list
  id is preserved. A second seed variant with `scrydexId="me55c-4"` populated asserts the
  match-by-scrydexId branch also reuses `base1-4`. This is the regression test for the exact
  failure the review caught.
- Search parity (offline, seeded): seed N per-printing rows for one known number in each game and
  assert `GET /api/cards/search` returns N separate results with distinct printing labels and
  distinct prices/images (AC-15/16/17).
- `filter-options` returns the same distinct set-name/rarity semantics after seeding per-printing
  rows (AC-18).
- Add-to-collection of two distinct printings of the same number yields two `UserCollection` rows;
  a repeat add of one printing increments quantity (AC-19).

### 8.3 Live parity check (credit-gated, owner-run — FR-5.1/5.2, AC-22)

A small script `scripts/verify-parity.ts` (dry-run by default) that, for a sample number per game
(One Piece `OP01-120`; a chosen multi-printing Pokémon card), compares the app's per-printing row
count + labels for that number against Scrydex's `variants[]` for that number. The offline half
(assert the DB holds the expected N per-printing rows for the known number after migration) runs
WITHOUT credits; the live half (one gated Scrydex call to read the real `variants[]`) runs only
with owner credit approval.

---

## 9. Error handling & validation (concrete)

- **Scrydex page fetch fails / non-2xx / Zod parse fail** (`fetchScrydexCatalogPage` /
  `pull-full-catalog` inline fetch): recoverable — warn-log + return null + retry with the
  existing exponential backoff (pull) / stop the game honestly (ingest). No fabrication. A page
  that never reaches Scrydex's app is not charged (credit-safe retries).
- **A mapped printing fails `NormalizedCardSchema`** (no set name, empty name, unusable image
  URL): recoverable per-row — DROP it, increment `invalid`, continue. Never a fabricated
  placeholder (RULE 2).
- **Upsert of one printing throws** (e.g. transient pooler error): recoverable per-row — catch,
  increment `invalid`, log the externalId, continue; the per-set transaction still commits the
  rest or rolls back the set on a fatal error (§5.4).
- **Credit gate denies** (`ScrydexCreditsNotApproved`): FATAL for the run — the script refuses to
  spend and exits non-zero before any write (AC-6). Caller sees the thrown gate error.
- **Per-set transaction fails mid-run:** that set rolls back (recoverable, resumable); the script
  logs the set and the before/after counts so the owner can re-run (AC-13).
- **Guarded delete pre-check finds owned refs:** the row is KEPT (not deleted) and logged; never
  a cascade (§5.3, AC-12).
- **Duplicate-base / unexpected net-increase assertion fails** (§5.1 — e.g. a scheme mismatch
  that produced two base rows or more new rows than non-base printings): FATAL for that set — the
  set's `$transaction` rolls back, the set is logged with its before/after counts, and the run
  halts non-zero so the owner investigates. The catalog is never left half-migrated (AC-13, HARD
  CONSTRAINT) — this is the loud failure that makes a Pokémon id-scheme surprise safe.
- **Search-cache flush fails (Redis fault):** recoverable and NON-fatal (RULE 1) — logged, the
  run still succeeds; the 5-minute `card:searchq` TTL lapses on its own.
- **Public read routes** (search / filter-options / prices): unchanged graceful degradation — 200
  + empty/fallback payload on error, never 5xx (NFR-4). The larger catalog does not change this.

### Input validation at boundaries
- Scrydex payloads: `ScrydexCatalogPageSchema` / `ScrydexCardSchema` / `VariantSchema` at the
  fetch boundary; `NormalizedCardSchema` at the map boundary (RULE 4). Required: `card.id`,
  `card.name`, a set name; `variant.name` defaults to `"normal"`. Limits: image URL must be
  absolute or `/`-rooted (schema refine) or the printing is dropped.
- Search request: `SearchQuerySchema` unchanged (+ optional nullable `printing` on the response
  schema only, not the request).
- Add-to-collection: `AddCardSchema` unchanged (resolves by `externalId`, now possibly a
  composite — still a non-empty string, no SCHEMA change). The ONE behavioural change is the
  new-card fallback `number` derivation, which strips the `::<variant>` suffix first
  (`item.externalId.split("::")[0]`) so a composite id never becomes a corrupted `number`
  (MEDIUM-2, §6.3).

### Invariant ownership
- **Per-printing uniqueness** is owned by `Card.externalId @unique` (DB layer) — the composite
  guarantees one row per printing; the ingest upsert keys on it for idempotency.
- **Owned-row integrity** is owned by the `UserCollection.cardId → Card.id` FK + the
  base-printing-preservation rule (§5.1), enforced by the migration script's before/after count
  assertions.
- **Credit safety** is owned by `scrydex-credit-gate.ts` (DENY by default), asserted before every
  live call.
- **No-fabrication** (RULE 2) is owned at the map boundary (drop invalid, null price → "—").

---

## 10. Testability summary

- **Unit-testable:** `baseVariantName`, `printingExternalId`, and both mappers' pure seams (one
  row per variant, drop-invalid, composite key) — the highest-risk logic, covered without DB or
  credits (§8.1).
- **Integration-testable:** search parity, filter-options invariance, add-to-collection
  per-printing distinctness — with mocked Prisma (§8.2).
- **Live/owner-run only:** the credit-spending re-ingest and the live `variants[]` comparison
  (§8.3), gated and never run by the agent.
- The design keeps all non-trivial logic in pure helpers precisely so the parity guarantees are
  provable offline before any credit is spent — a design that is hard to test would have put the
  key/base-printing decision inside the live runner; this one does not.

---

## Appendix — evidence files inspected

- `src/lib/services/scrydex.service.ts` — `VariantSchema`, `ScrydexCardSchema` (one id + nested
  `variants[]`), `pickImageEntry`, `pickRawPrice`, `pickGradedPrice`, `pickVariantImages`.
- `.full-pull-onepiece.log` (`total_count=2840`), `.full-pull.log` / `.full-pull-pokemon.log`
  (`total_count=47481`) — catalog-list cardinality ≈ 1 entry per number.
- `scripts/ingest-onepiece-catalog.ts` — `mapScrydexCatalogCard` (one row per `card.id`),
  `upsertOnePieceCard`.
- `scripts/pull-full-catalog.ts` (repo root; NOT on the worktree branch — must be brought in) —
  `buildCardRow` / `buildPriceRows` (Pokémon collapse).
- `prisma/schema.prisma` — `Card` (`externalId @unique`, `scrydexId @unique` with the
  `me55c-4` vs `base1-4` namespace comment, `number` non-unique, `variantImages Json?`),
  `CurrentPrice`/`PricingHistory` keys, the `onDelete: Cascade` chains, `UserCollection`,
  `WantListItem` (external-id `cardId`, not an FK, `base1-4`/`OP01-001` comment).
- `prisma/seed.ts` + `src/lib/services/card.service.ts` (`searchPokemonCards` → `fetchPokemonTcg`
  pokemontcg.io `base1-4` ids / `fetchTcgdex` fallback) — proves existing Pokémon
  `Card.externalId` is `base1-4`-style, NOT the Scrydex native id. Evidence for HIGH-1/HIGH-2.
- `scripts/pull-full-catalog.ts` (repo root; NOT on the worktree branch — must be brought in) —
  `buildCardRow`/`buildPriceRows` writing `externalId: c.id, scrydexId: c.id`; confirmed it has
  NO credit gate / dry-run / `--apply` (MEDIUM-3).
- `src/lib/utils/card-number.ts` — `isOnePieceCode` / `deriveStoredCardNumber` proving OP
  `card.id` IS the Bandai code = existing `externalId`.
- `src/app/api/users/me/collection/route.ts` — resolves by `externalId` OR `id`; comment confirms
  Pokémon ids are `base1-4`.
- `src/lib/redis.ts` — `RedisKeys.cardSearchResult` (`card:searchq:` prefix) with
  `CACHE_TTL.cardSearch = 300` (5 min), and the separate 24h `card:search:` service-layer key
  (MEDIUM-2).
- `src/app/api/cards/search/route.ts`, `src/lib/validators/card.validator.ts`,
  `src/lib/utils/set-key.ts`, `src/app/api/users/me/collection/route.ts`,
  `src/app/(dashboard)/search/[id]/page.tsx`, `src/app/api/cards/[id]/prices/route.ts`,
  `src/app/(dashboard)/scanner/page.tsx`, `src/app/api/cards/recognize/route.ts` — the read/UI
  paths and the `variantImages` consumers to retire.
- `.agents/tasks/onepiece-catalog-audit/findings.md` — set-dedup guard-rail + cascade risks.

---

## Responses to design-review findings (Revision 2)

The review returned `CHANGES_REQUESTED` with 2 HIGH + 3 MEDIUM findings. Every finding is
ADDRESSED. Summary of disposition and where in this document it is resolved:

- **HIGH-1 — Pokémon `card.id` (`me55c-4`) ≠ existing `externalId` (`base1-4`); identity
  unverified. ADDRESSED.** Verified with real source (new evidence #4 in §1.2): the Pokémon seed
  path (`prisma/seed.ts → searchPokemonCards → fetchPokemonTcg`) writes pokemontcg.io `base1-4`
  ids, while the Scrydex catalog `card.id` is the native `me55c-4`; the schema and
  `scrydex.service.ts` both document the distinct namespaces, and the collection route's own
  comment says Pokémon ids are `base1-4`. The design no longer assumes `card.id == externalId` for
  Pokémon. §1.1 now defines `baseId` as the EXISTING row's id (not the Scrydex id), and §5.1 adds
  an explicit MATCH-THEN-UPSERT step (match by `scrydexId`, else `number + setId`) that reuses the
  found row's `externalId` verbatim for the base printing. A read-only owner query is given in
  §1.2 to pin the live scheme (the migration is correct for either outcome). WantListItem
  reconciliation for the `base1-4` case is spelled out in §5.5.

- **HIGH-2 — "zero deletes = safe" only held under HIGH-1's bad assumption; a mismatch would
  silently duplicate. ADDRESSED.** §5.1 is now match-then-upsert on a scheme-independent identity
  (not blind-upsert-on-key), so no duplicate base row is created when schemes differ. Added a
  per-set duplicate-base assertion (exactly one base row per number+set) and a net-`Card`-increase
  assertion (increase == non-base printings created); either failing rolls the set back and halts
  loud (§5.1, §5.4, §9). Silent duplication is now impossible.

- **MEDIUM-1 — base selection "else first variant" depends on unverified `variants[]` order.
  ADDRESSED.** `baseVariantName` is now ORDER-INDEPENDENT: "normal" if present, else the
  lexicographically-smallest `variant.name` (a total order on a stable field, not array position)
  — §4.1. Added an order-independence unit test (§8.1).

- **MEDIUM-2 — the search cache serves stale pre-parity results after `--apply`. ADDRESSED.**
  §6.1 picks and documents a cache story: `--apply` flushes `card:searchq:*` and `card:search:*`
  at end of run (best-effort, RULE 1). Also corrected the TTL: the catalog-read route cache is
  `CACHE_TTL.cardSearch = 300s` (5 min), not 24h; the 24h key is a separate service-layer path.
  The parity verify script reads the DB directly so it is never tripped by a stale blob (§8.3).

- **MEDIUM-3 — `PLAN.md` path + Pokémon-script "extend vs add" gate wording. ADDRESSED.** The
  header note now states `PLAN.md` lives at the REPO ROOT, not the worktree task folder. §4.3 now
  states explicitly that the current master `pull-full-catalog.ts` has NO credit gate, NO dry-run,
  and NO `--apply`, and that the rewrite must ADD `assertScrydexCreditsApproved("standard",
  pages)`, the dry-run default, the `--apply` flag, and before/after counts — matching the One
  Piece script — rather than "extend" an absent contract. §4.4 wording corrected accordingly.

No finding was backlogged or declined; all five are resolved in-line and consistent with the
requirements (zero data loss, idempotent re-ingest, credit gate, parity for both games).

---

## Responses to design-review findings (Revision 3)

The second review returned `CHANGES_REQUESTED` with 2 MEDIUM + 4 NIT findings against Revision 2.
Every finding is ADDRESSED in-line; none backlogged or declined. Disposition:

- **MEDIUM-1 — imageless NON-base printings were silently dropped (parity miss). ADDRESSED.**
  §4.2 (One Piece) and §4.3 (Pokémon) now set
  `imageUrl = pickImageEntry(variant.images) ?? pickBaseImageUrl(card/c)` — the base card art is
  the fallback for EVERY printing, not just the base. A printing is dropped ONLY when the base
  card is itself imageless (the same card dropped today). Falling back to the base card's real
  Scrydex art is honest (not fabrication, RULE 2). Added a §8.1 unit test: a 3-variant card with
  one empty-images variant emits 3 rows (the imageless variant carrying base art), not 2; a
  base-imageless case still drops.

- **MEDIUM-2 — `Card.number` for a composite externalId was unspecified on the add new-card
  fallback. ADDRESSED.** §6.3 makes it a written decision: the new-card fallback in
  `src/app/api/users/me/collection/route.ts` POST strips the base id first
  (`const baseExt = item.externalId.split("::")[0]`) before `deriveStoredCardNumber`, so a
  composite id never becomes a corrupted `number`. It is a one-line change, a no-op for
  non-composite ids, and leaves `AddCardSchema` unchanged (confirmed against the real POST that
  computes `number: deriveStoredCardNumber(item.externalId, isOnePieceCode(item.externalId))`).
  The §9 validation appendix is updated to name this as the single behavioural change.

- **NIT-1 — `PLAN.md` absent at the worktree task-folder path. ADDRESSED (no design change
  required).** The header note already states `PLAN.md` lives at the REPO ROOT and that this
  design cites the repo-root path as authoritative; the owner/implementer may copy it into the
  worktree task folder. The review itself notes no design change is needed beyond the existing
  note.

- **NIT-2 — "resumable paging already present are kept" understated the write-primitive change.
  ADDRESSED.** §4.3 now states explicitly that the per-set transactional match-then-upsert loop
  (§5.4) REPLACES `createMany({ skipDuplicates: true })` as the Pokémon idempotency/resume
  mechanism, and that `START_PAGE`/`MAX_PAGES` remain only as coarse manual knobs (not the
  correctness mechanism).

- **NIT-3 — the Pokémon base match keyed on raw `setId` could miss and silently green-field a
  seed row. ADDRESSED.** §5.1 step (b) and the §4.3 copy now match on `game` + SET NAME + the
  `normNumber`/tail logic (mirroring `resolveScrydexCard`'s `expansion.name` match), NOT raw
  `setId` equality, because seeded Pokémon rows and Scrydex-keyed sets can be different `CardSet`
  rows. The §1.2 owner pre-check query is upgraded to MANDATORY before Pokémon `--apply`, and if
  the pre-check shows seed-row set names that do not line up with Scrydex expansion names,
  Pokémon set reconciliation must precede the per-printing ingest. The duplicate-base assertion
  catches a double base; the set-NAME match + mandatory pre-check close the clean-miss gap.

- **NIT-4 — the `variantImages` removal must also drop the `upsertOnePieceCard` write branch and
  the `canonical(variantImages)` unchanged term. ADDRESSED.** §4.2 now states the
  `upsertOnePieceCard` rewrite removes (1) the `...(hasVariantImages ? { variantImages } : {})`
  write branch and (2) the `canonical(prior.variantImages) === canonical(m.variantImages)` term
  from its `unchanged` comparison (plus the dead `hasVariantImages`/`canonical`/`VariantImageMap`
  locals), replacing the dropped term with a `prior.printing === m.printing` equality so AC-5
  idempotency holds on the new per-printing field. Verified against the real
  `scripts/ingest-onepiece-catalog.ts` (the `hasVariantImages` branch and the `canonical()`
  equality both exist as described).
