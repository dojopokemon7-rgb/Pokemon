# Plan: Full Scrydex-Parity Catalog (every printing/variant = its own card)

> **Status:** APPROVED GOAL, NOT YET IMPLEMENTED. This is a durable, self-contained
> execution plan written for a FRESH agent session (or another developer) with full
> budget. It assumes NO memory of the conversation that produced it. Read it top to
> bottom before touching anything.
>
> **Owner's stated goal (verbatim intent):** "Whatever we search in Scrydex, the same
> must appear in our app." I.e. every distinct printing/variant Scrydex returns (Foil,
> Alt Art, Manga Alt Art, Reprint, Secret Rare, etc.) must be a SEPARATE, searchable,
> ownable, individually-priced card in the Dojo app — for BOTH One Piece AND Pokémon.
>
> **Owner constraints:** Do NOT leave the catalog half-migrated. Scrydex credits are
> limited — estimate and gate every credit-spending call. The app is LIVE in production
> (dojocollect.com) with real users possible, so the migration must be zero-downtime or
> clearly scheduled.

---

## 1. The problem (confirmed, with evidence)

The Dojo catalog stores **one `card` row per card NUMBER**, collapsing all printings of
that number into a single row. Scrydex stores **one entry per PRINTING/VARIANT**.

**Confirmed in prod (Supabase Mumbai, `public` schema), 2026-10-16:**
- Search "OP01-120" (Shanks, Romance Dawn):
  - **Scrydex: 125 results** — Foil (OP01) $8.01, Alt Art (OP01) $76.68, Manga Alt Art (OP01), Reprint (PRB01), Secret Rare, … each a distinct card with its own art + price.
  - **Dojo app: 1 result** — a single `card` row (`externalId = "OP01-120"`, `number = "OP01-120"`, rarity "Secret Rare", `variantImages` present).
- Prod query proved the 1:1 collapse: Romance Dawn (OP01) has **121 card rows and 121 distinct numbers** — exactly one row per number, zero variant rows.
- The variants' very different values ($8 foil vs $76 alt-art vs $80 manga) make this a real product defect for a collection/portfolio app: a user cannot own or price-track the SPECIFIC printing they hold.

**Root cause in the ingest** (`scripts/ingest-onepiece-catalog.ts`, `mapScrydexCatalogCard`):
- `externalId = card.id` (the Scrydex card id).
- `number = deriveStoredCardNumber(externalId, true)` — collapses the Scrydex id to the
  bare Bandai number (e.g. `OP01-120`), so two Scrydex printings that share a number map
  to the SAME `number` and (critically) the SAME `externalId` if Scrydex reuses the base
  id for the "main" printing — the variants were either never pulled as separate rows or
  were deduped away on `externalId`/`number`.
- Variant art was bolted on later as a `Card.variantImages Json?` map on the single row
  (a half-measure: it shows alternate IMAGES but keeps ONE price, ONE search result, ONE
  ownable entity). This plan REPLACES that half-measure with real per-variant rows.

Same collapse almost certainly affects **Pokémon** (reverse-holo, full-art, alt-art,
promos) — VERIFY in Phase 0 before committing to the Pokémon re-ingest.

---

## 2. The target model

**Each Scrydex printing becomes its own `Card` row**, uniquely keyed by the Scrydex card
id (which is already distinct per printing). Search returns each printing as its own
result, exactly like Scrydex. A user owns/tracks a specific printing.

Decisions to lock before coding (Phase 1 design):
- **Primary key for a card = the Scrydex card id**, verbatim, in `Card.externalId`. Do NOT
  collapse it to the Bandai number. Keep a SEPARATE `Card.number` = the human Bandai
  number (e.g. `OP01-120`) for display/grouping, but it is NO LONGER unique.
- **A new field to label the printing** so the UI can show "Foil" / "Alt Art" / "Manga
  Alt Art" / "Reprint" next to the number (Scrydex returns this — capture it, e.g.
  `Card.printing` or reuse `rarity` + a `variant`/`finish` column). Confirm the exact
  Scrydex field names in Phase 0.
- **`Card.variantImages` is RETIRED** as the variant mechanism (it may stay as a nullable
  column for back-compat but is no longer how variants are modeled — each variant is now a
  row with its own `imageUrl`).
- **Pricing**: each printing row carries its own `CurrentPrice`/`PricingHistory` (already
  keyed by `cardId`, so this works once rows are per-printing).
- **Search grouping**: decide whether search shows a flat list of all printings (Scrydex
  style) or groups by number with variants expandable. Owner wants Scrydex parity → flat
  list of distinct printings is the default; confirm.

---

## 3. Credit + scale estimate (DO THIS FIRST — Phase 0, read-only)

Before spending ANY Scrydex credit on a re-ingest, measure:
1. Hit the Scrydex catalog endpoint for ONE set (e.g. OP01) and count how many card
   entries it returns vs how many unique Bandai numbers — this gives the **variant
   multiplier** (e.g. if OP01 returns ~250 entries for ~121 numbers, multiplier ≈ 2.0).
2. Apply the multiplier to estimate the new catalog size:
   - One Piece: 2,897 current → estimate ~X,XXX with variants.
   - Pokémon: 50,559 current → estimate ~XX,XXX with variants (this is the big one).
3. **Scrydex credit cost of a full catalog re-pull**: the existing `scripts/pull-full-catalog.ts`
   is credit-gated (`scrydex-credit-gate.ts`, DENY by default). Compute pages × cost/page
   for BOTH games from the script's own page math. Record the number. DO NOT run it until
   the owner approves the credit spend.
4. **Agent-budget estimate**: this is a multi-phase build (schema migration + ingest rewrite
   + search rework + data migration + verification). It is LARGE. If agent budget is low,
   execute it as its OWN fresh full-budget session using THIS plan — do not start it with a
   near-empty budget (a half-migrated catalog is worse than the current state).

Output Phase 0 as a short findings note appended to this file: variant multiplier, new
size estimates, exact Scrydex credit cost, Pokémon-affected yes/no.

---

## 4. Execution phases (in order — each is independently verifiable)

### Phase 0 — Measure (read-only, ~0 Scrydex credits)
- Confirm the variant multiplier + Pokémon impact + credit cost (section 3).
- Confirm the exact Scrydex API fields that distinguish printings (id, name, a
  printing/finish/variant label, rarity). Document them.
- GATE: owner approves the credit spend and the new catalog size before Phase 2.

### Phase 1 — Schema + ingest design (no credits, no prod writes)
- Prisma migration: make `Card.externalId` the Scrydex-id key (already unique — good);
  DROP any uniqueness on `number`; add the printing-label column(s); keep `game`.
  (Check: `Card.externalId` is already `@unique` — if Scrydex ids are already distinct
  per printing, NO schema change to the key is needed; the fix is purely INGEST + a
  printing-label column.)
- Rewrite `mapScrydexCatalogCard` (and the Pokémon equivalent in the pull/ingest path) to
  emit ONE mapped card PER Scrydex entry — stop collapsing on `deriveStoredCardNumber`.
  `number` = Bandai number (non-unique, display), `externalId` = Scrydex id (unique, key).
  Capture the printing label.
- Build a design doc + a reviewed PR on a branch. No prod touch yet.

### Phase 2 — Re-ingest (spends Scrydex credits — GATED)
- Run the rewritten ingest for One Piece first (smaller, cheaper) → verify a known card
  (OP01-120 Shanks) now returns the SAME printings Scrydex shows.
- Then Pokémon (big, more credits) → verify a known multi-printing Pokémon card.
- Idempotent: re-running must not duplicate. Keyed on Scrydex id.
- Do it on STAGING first (staging.dojocollect.com, isolated `staging` schema) if credits
  allow a staging pull; otherwise ingest straight to prod in a transaction per set with
  before/after counts.

### Phase 3 — Search / explore / collection UI
- Search returns each printing as its own result (Scrydex parity).
- Card detail + add-to-collection: the printing is part of the card identity, so owning
  "Alt Art Shanks" vs "Foil Shanks" are different owned rows (the add flow already keys on
  cardId + condition; per-printing cards make this correct automatically).
- Retire the `variantImages`-on-one-row display path.

### Phase 4 — Clean up the old collapsed rows
- The old 1-row-per-number cards must be reconciled with the new per-printing rows:
  either the re-ingest UPSERTS the base printing onto the existing row and ADDS the
  variants as new rows, or you migrate then delete orphaned old rows. Define precisely in
  Phase 1 so no card/price/history is lost (CardSet→Card and Card→price/history are all
  onDelete:Cascade — deleting carelessly destroys data).
- Run the existing `scripts/reconcile-onepiece-sets.ts` (already built, on master at commit
  b3f1d52) FIRST or AFTER as appropriate — note it dedupes SET rows, a related but separate
  cleanup. Sequence the two so they don't fight.

### Phase 5 — Verify parity
- For a sample of cards in BOTH games, assert the app's search result set == Scrydex's for
  the same query (count + the distinct printings). This is the acceptance test for "whatever
  Scrydex shows, our app shows."

---

## 5. Hard safety rules (do not violate)

1. **Never leave the catalog half-migrated in prod.** Migrate per-set in transactions with
   before/after counts, or do it on staging first. If a phase can't complete, roll back.
2. **Gate every Scrydex credit.** `scrydex-credit-gate.ts` DENY by default. Estimate cost in
   Phase 0; get explicit owner approval before Phase 2.
3. **No data loss.** CardSet→Card and Card→(UserCollection, PricingHistory, CurrentPrice,
   SoldListing, PopulationReport) are all `onDelete: Cascade`. Any delete must be of a row
   proven empty/orphaned. Assert catalog counts before/after every destructive step.
4. **Users may exist by the time this runs.** (Prod users were flushed on 2026-10-16, but
   real signups may have happened since.) Check `UserCollection` references before any
   card delete; a per-printing migration must not orphan owned rows.
5. **Idempotent ingest** keyed on Scrydex card id.
6. **Follow AGENTS.md**: Zod at boundaries, RULE 2 (never fabricate — a printing with no
   price shows "—"), server/client discipline, the one-off-container pattern for running
   scripts against the Droplet DB.

---

## 6. How to run scripts against prod (the Droplet pattern)

The standalone app image lacks loose `scripts/`, the `prisma` CLI, and `src/`. Run one-off
scripts by mounting the host repo into the app image:
```bash
cd /opt/dojo
set -a; . ./.env; set +a      # prod creds (or .env.staging for staging)
docker compose run --rm \
  -v "$PWD/scripts:/app/scripts" -v "$PWD/src:/app/src" -v "$PWD/prisma:/app/prisma" \
  -e DATABASE_URL="$DATABASE_URL" -e DIRECT_URL="$DIRECT_URL" \
  app sh -c "npx -y tsx scripts/<the-script>.ts"      # add --apply to execute
```
Prisma CLI needs pinning to v6: `npx -y prisma@6 ...` (plain `npx prisma` fetches a v8 RC
whose `migrate` command was renamed).

---

## 7. Current related state (so the executor has context)

- **Repo:** d:\Pokemon\Pokemon, branch master. Prod live at dojocollect.com (Droplet
  168.144.121.2, /opt/dojo, Caddy+Docker). Staging at staging.dojocollect.com (same Droplet,
  `app-staging` container :3001, isolated `staging` Postgres schema, Caddy basic-auth).
- **Catalog now:** 50,559 Pokémon + 2,897 One Piece cards; One Piece has duplicate SET rows
  being cleaned by `scripts/reconcile-onepiece-sets.ts` (commit b3f1d52, run with dry-run
  then --apply).
- **Key files:** ingest `scripts/ingest-onepiece-catalog.ts` (`mapScrydexCatalogCard`,
  `upsertOnePieceCard`); full pull `scripts/pull-full-catalog.ts` (Pokémon + OP, credit-gated);
  set-key `src/lib/utils/set-key.ts`; schema `prisma/schema.prisma` (Card, CardSet, CurrentPrice,
  PricingHistory); search `src/app/api/cards/search/route.ts`; trending
  `src/app/api/cards/trending/route.ts`; filter options `src/app/api/cards/filter-options/route.ts`.
- **Scrydex:** `SCRYDEX_API_KEY`/`SCRYDEX_TEAM_ID` in .env; credit gate in
  `src/lib/utils/scrydex-credit-gate.ts` (`SCRYDEX_LIVE_CREDITS_APPROVED` env / Redis approval).

---

## 8. Recommended first action for the executor

Start a FRESH full-budget session, open this file, and do **Phase 0 only** (read-only,
no credits): produce the variant multiplier, the new catalog-size estimates for both games,
the exact Scrydex credit cost of a full re-pull, and confirm whether Pokémon is affected.
Append the numbers to this file. THEN get the owner's go/no-go on the credit spend before any
re-ingest. Do not begin Phase 2 without that approval and a full budget to finish Phases 2–5
in one go.

---

## Phase 0 Findings (READ-ONLY measurement — 0 Scrydex credits spent)

> Produced by the Phase-0 measurement pass. **No code changed, no DB write, no git
> commit/push, and ZERO Scrydex credits spent** — every number below is derived from the
> ingest code, the Scrydex Zod response schema, and the cached prior-pull logs at repo root
> (`.full-pull.log`, `.full-pull-pokemon.log`, `.full-pull-onepiece.log`). The one place I
> could NOT verify from static evidence (the exact composition of the owner's "125 results")
> is flagged explicitly with the precise probe to run — I did not guess around it.

### 0. The single most important answer — is a re-ingest free or does it cost extra credits?

**A re-ingest is FREE of extra Scrydex credits — the variant data is ALREADY in the pages we
already pull; the current ingest RECEIVES it and then COLLAPSES it to one row.** This is the
key go/no-go fact and it is provable from the code + schema, not assumed:

- The Scrydex catalog-list endpoint used by both ingest paths is
  `GET /{slug}/v1/cards?q=&include=prices&pageSize=100&page=N`
  (`fetchScrydexCatalogPage`, `src/lib/services/scrydex.service.ts`; and the inline fetch in
  `scripts/pull-full-catalog.ts`). Each page costs **1 credit** and returns up to 100 **card
  entries**.
- Each card entry already carries a nested **`variants[]`** array in the response Zod schema
  (`ScrydexCardSchema.variants` → `VariantSchema { name, prices[], images[] }`). The variant's
  **name** (e.g. "normal", "reverse holofoil", "foil", "alt art") AND its own **images[]** AND
  its own **prices[]** are all in the SAME page payload — no second call per variant.
- Proof the data arrives today: the ingest already READS those nested variants —
  `pickVariantImages(card)` (scrydex.service.ts) walks `card.variants[]` and builds the
  `Card.variantImages` JSON map, and `buildPriceRows`/`pickRawPrice` walk `card.variants[].prices[]`.
  The prior OP pull wrote **21,491 CurrentPrice rows from 2,640 cards** (`.full-pull-onepiece.log`)
  — i.e. the per-variant/-condition/-grade price entries were all present in the pages and got
  stored. The ONLY thing collapsed is the **Card row**: `mapScrydexCatalogCard` emits exactly ONE
  `MappedOnePieceCard` per `card.id`, and `pickVariantImages` demotes the printings to a display-only
  JSON map on that single row instead of emitting one Card row per printing.
- **Conclusion:** making each printing its own Card row is a pure INGEST-MAPPING change
  (emit one row per `variants[]` entry, key it on `card.id` + variant name/index, keep
  `number` = Bandai code as a non-unique display field). The number of **pages** fetched — and
  therefore the credits — is **unchanged**. A re-ingest costs the SAME ~1 credit/page as the
  original pull, NOT more.

### 1. The variant multiplier

- **Catalog-list cardinality is ~1 entry per Bandai number, NOT per printing.** Scrydex's own
  `total_count` on the catalog-list endpoint is **2,840 for One Piece** and **47,481 for
  Pokémon** (both read straight from the logs). Prod currently holds 2,897 OP + ~50,559 PKM —
  i.e. the catalog list ALREADY maps ~1:1 to today's rows. If Scrydex returned each printing as
  its own top-level `card.id`, these totals would be multiples larger; they are not. So the
  printings live in the nested `variants[]`, exactly as the schema shows.
- **The expansion factor is the mean length of `variants[]` per card** (each becomes its own
  row after the re-map). From the cached logs I can bound it but not pin it exactly, because the
  logs count **CurrentPrice rows**, not distinct `variant.name`s, and a price row is
  variant×condition×(raw|grade) — an OVER-count of true printings:
  - One Piece: 21,491 price rows / 2,640 cards ≈ **8.1 price rows/card** (upper bound on the
    multiplier; true printing multiplier is lower because grades/conditions inflate it).
  - Pokémon: the log's price rows climb to 6-figures over 47k cards → similar order
    (~10 price rows/card upper bound).
  - **Realistic printing multiplier estimate: ~1.5×–3× distinct printings per number** (foil /
    reverse-holo / alt-art / manga / reprint / secret are typically 1–4 per number, many cards
    have exactly 1). This is an **ESTIMATE** — the exact mean needs ONE cheap probe (below).
- **The "125 results" claim (§1) is NOT confirmed as 125 distinct catalog printings.** The
  catalog-list total for ALL of One Piece is only 2,840, so 125 cannot be the number of
  catalog `card.id`s for a single Bandai number via the list endpoint. The 125 most likely came
  from the Scrydex **web dashboard** search, which almost certainly fans out across
  variants[] + cross-set reprints (PRB01 etc., which ARE separate numbers/cards) + other
  languages + graded listings. **I could not verify the exact composition of 125 from static
  evidence and did not assume it.** To pin the TRUE per-number printing multiplier, run ONE
  gated 1-credit probe (only if the owner approves opening the gate):
  ```bash
  # ONE page-1 catalog probe (1 credit) that prints, per card, how many distinct
  # variant.name values Scrydex returns — the real multiplier, no dashboard ambiguity.
  curl -s "https://api.scrydex.com/onepiece/v1/cards?q=&include=prices&pageSize=100&page=1" \
    -H "X-Api-Key: $SCRYDEX_API_KEY" -H "X-Team-ID: $SCRYDEX_TEAM_ID" \
  | jq '[.data[] | {id, n_variants: (.variants|length), variant_names: [.variants[].name]}]
        | {cards: length, total_variants: (map(.n_variants)|add),
           mean_variants: ((map(.n_variants)|add)/length)}'
  # mean_variants IS the printing multiplier. Also eyeball a known multi-print number:
  curl -s "https://api.scrydex.com/onepiece/v1/cards?q=number:OP01-120&include=prices" \
    -H "X-Api-Key: $SCRYDEX_API_KEY" -H "X-Team-ID: $SCRYDEX_TEAM_ID" \
  | jq '[.data[] | {id, number, n_variants:(.variants|length), names:[.variants[].name]}]'
  ```

### 2. New catalog-size estimate (both games)

Using the realistic printing multiplier band (1.5×–3×) applied to today's distinct-number rows:

| Game | Current rows | ×1.5 (low) | ×2 (mid) | ×3 (high) |
|---|---|---|---|---|
| One Piece | ~2,897 | ~4,350 | ~5,800 | ~8,700 |
| Pokémon | ~50,559 | ~75,800 | ~101,000 | ~151,700 |
| **Total** | **~53,456** | **~80,000** | **~107,000** | **~160,000** |

All **ESTIMATES** — formula = current_rows × printing_multiplier. The probe in §1 replaces the
band with one real number before Phase 2. (These are ROW counts; price-row counts scale with
them but don't change the credit math, which is per-page.)

### 3. Exact Scrydex credit cost of a full re-ingest (both games)

Page math (both ingest scripts): `pages = ceil(total_count / 100)`, **1 credit per page**
(`SCRYDEX_CREDIT_COST.standard = 1`, scrydex-credit-gate.ts).

| Game | total_count (from logs) | pages = ceil(total/100) | credits @1/page |
|---|---|---|---|
| One Piece | 2,840 | 29 | **~29** |
| Pokémon | 47,481 | 475 | **~475** |
| **Full re-pull BOTH** | — | 504 | **~504 credits** |

Assumptions: (a) 1 credit/page with `include=prices` (confirmed cost table + the prior pull
logs, which incremented exactly 1 credit/page); (b) `total_count` stable at the logged values;
(c) the re-ingest pages the SAME endpoint (it does) so page count — and thus credit cost — is
**identical to the original pull regardless of how many rows each page is expanded into**.
This is the crux: **the re-map multiplies ROWS, not PAGES, so it does NOT multiply credits.**

> ⚠️ **Credit-budget reality check:** the owner stated only **52 Kiro credits** remain *in this
> working context* — that is the agent/session budget, a DIFFERENT pool from Scrydex API
> credits. The ~504 figure above is **Scrydex API credits**. One Piece alone (~29 Scrydex
> credits) is the cheap, low-risk first target; Pokémon (~475) is the expensive one. If Scrydex
> credits are scarce, do One Piece first, verify parity, then decide on Pokémon.

### 4. Is Pokémon affected? — YES, identically.

- `scripts/pull-full-catalog.ts` is the Pokémon path (`GAMES=pokemon`). Its `buildCardRow`
  emits ONE Card per `card.id` and its `buildPriceRows` reads `c.variants[].prices[]` — the
  SAME nested-variant shape, same collapse. Reverse-holo / 1st-edition / holofoil printings sit
  in `variants[]` and are flattened to one Card row (+ nested price rows) exactly like One
  Piece. The Pokémon log climbing to 6-figure price-row counts over 47k cards confirms the
  nested variants arrive in-page for Pokémon too.
- **Prod reasoning check:** Pokémon shows ~50,559 rows vs Scrydex `total_count` 47,481 — i.e.
  ~1 row per catalog entry (the ~3k excess is from earlier seed/multi-source runs, not
  per-printing expansion). So Pokémon is collapsed to 1-row-per-number just like OP.
- I did **not** have live prod DB access from this step. To let the owner confirm the
  Pokémon 1-row-per-number collapse with a read-only query (the Droplet one-off pattern, §6):
  ```sql
  -- Rows-per-number for Pokémon: if ~1.0, printings are collapsed (expect ~1.0 today).
  SELECT count(*) AS rows,
         count(DISTINCT c.number) AS distinct_numbers,
         round(count(*)::numeric / NULLIF(count(DISTINCT c.number),0), 3) AS rows_per_number
  FROM "Card" c
  JOIN "CardSet" cs ON cs.id = c."setId"
  WHERE cs."externalId" LIKE 'pokemon-%';
  -- And a known multi-print card (Charizard base1-4): expect 1 row today.
  SELECT c.number, count(*) FROM "Card" c
  JOIN "CardSet" cs ON cs.id=c."setId"
  WHERE cs."externalId" LIKE 'pokemon-%' AND c.number IN ('4','4/102')
  GROUP BY c.number;
  ```

### 5. Agent-budget / build-size assessment

Phases 1–5 are a **LARGE multi-phase build**: a Prisma schema change (printing-label column +
drop `number` uniqueness), an ingest-mapper rewrite for BOTH games, search/explore/collection
UI rework, a data migration that reconciles old collapsed rows against new per-printing rows
without violating the `onDelete: Cascade` chains, and a parity-verification suite. This MUST
run as its **own fresh, full-budget agent session** — NOT started piecemeal on a near-empty
budget. A half-migrated prod catalog is worse than today's state (Hard Safety Rule #1). With
only ~52 Kiro session credits here, **do NOT begin Phase 1+ in this context.**

### 6. GO / NO-GO gate (owner decision)

**Re-ingest will cost ~504 Scrydex credits total (~29 One Piece + ~475 Pokémon, @1 credit/page,
pages = ceil(total_count/100)), is FREE of any EXTRA per-variant API calls (every printing is
already in the `variants[]` of the pages we already pull — the current ingest receives them and
collapses them to one row, so the re-ingest is a mapping change that multiplies ROWS, not
PAGES, not credits), and would grow the catalog from ~53k rows to an estimated ~80k–160k rows
(printing multiplier ~1.5×–3×, to be pinned by one cheap 1-credit probe before Phase 2).
Pokémon IS affected identically to One Piece. Recommended sequencing: One Piece first (~29
credits, cheap, low-risk) to prove parity, then Pokémon (~475) — and run Phases 1–5 as a
single fresh full-budget session, never piecemeal. Proceed?**



---

## EXECUTION STATUS (updated 2026-10-16) — DESIGN DONE, BUILD NOT STARTED

A full build workflow ran the **requirements + 3-round reviewed design loop** for BOTH games,
then aborted on the design loop's max-iteration cap (3) WITHOUT a final APPROVED stamp. The
design is substantively complete and its hard decisions were verified against source across all
three reviews — it stopped on refinement gaps, not design flaws. **Nothing was built, no schema
changed, no DB touched, no credits spent, nothing committed to master.**

### Artifacts produced (in THIS folder, preserved from the worktree)
- `requirements.md` — 24 testable acceptance criteria, all 5 phases, both games.
- `design.md` — **Revision 3**, the authoritative design. 63 KB. Read this to implement.
- `design-review.md` / `design-review.json` — the 3rd review (verdict CHANGES_REQUESTED: 1 HIGH, 2 MEDIUM, 4 NIT).

### What the design LOCKED IN (verified against real source — reuse, do not re-litigate)
1. **Per-printing key = composite `externalId = "${baseId}::${variantName}"`.** Scrydex nests
   printings in one `card.id`'s `variants[]` (no per-variant id) — proven from `ScrydexCardSchema`.
   The base/normal printing keeps the EXISTING row's `externalId` verbatim; non-base printings
   are new `::`-suffixed rows. Add a nullable `printing` label column; drop `scrydexId @unique`
   (printings share one Scrydex id); `number` stays the non-unique Bandai code; retire
   `variantImages` as the variant mechanism.
2. **Pokémon identity trap (critical):** Scrydex's Pokémon `card.id` ("me55c-4") is NOT the
   seeded Pokémon `Card.externalId` ("base1-4", from pokemontcg.io). So reconciliation is
   MATCH-THEN-UPSERT on a scheme-independent identity (match by `scrydexId`, else `number`+set),
   reusing the matched row's `externalId` verbatim for the base printing → preserves every
   `UserCollection.cardId` FK and `WantListItem.cardId` (bare Bandai code) for BOTH games.
3. **Migration = the re-ingest.** Base printing upserts onto the existing row (zero deletes on
   the normal path → no onDelete:Cascade fires); extra printings added as new rows. Per-printing
   image falls back to base card art when a printing has no own image (so alt/reverse printings
   become rows, never dropped). Credit-gated, dry-run default, OWNER-run.

### The 3 OPEN findings a fresh session must resolve before/while building (from design-review r3)
- **HIGH-1:** "per-set transactional, never half-migrated" needs a CONCRETE mechanism — the
  Scrydex ingest is page-based/non-transactional. Name it: e.g. buffer a full set's cards in
  memory, then one `prisma.$transaction` per set with before/after count assertions; or stage to
  a temp table then swap. Decide and specify.
- **MEDIUM-1:** the net-Card-increase assertion (the sole guard for a Pokémon set-name miss) is
  under-specified for RE-RUNS (idempotent second run = net 0 increase, must not false-alarm) and
  for cross-set splits. Tighten it.
- **MEDIUM-2:** the guarded-delete helper is specified but never fed an orphan-enumeration set —
  define what rows it may delete (only rows proven 0 owned refs AND superseded by a re-keyed
  printing) or drop it (the normal path has zero deletes anyway).

### HOW TO RESUME (recommendation for a FRESH full-budget session)
This is a LARGE build and must run end-to-end without running out of agent budget (a half-done
schema migration on prod is the worst failure mode). In a fresh session:
1. Launch a build workflow that SKIPS the design phase (design.md r3 is authoritative) — go
   straight to: resolve the 3 open findings in a short design addendum → plan → implement→review
   loop → finalize (rebase onto master, no push). Point it at this folder's `design.md` +
   `requirements.md` as the spec, and list the 3 findings above as mandatory corrections.
2. Keep the hard rules: code lands as a reviewed unit on master; the DB re-ingest is a GATED
   dry-run-default script the OWNER runs (One Piece ~29 Scrydex credits first → verify parity on
   Shanks OP01-120 → Pokémon ~475). Staging-first. Redis search-cache flush after `--apply`
   (`card:searchq:*` 300s + `card:search:*` 24h). Never leave the catalog half-migrated.
3. Parity acceptance: app per-printing results == Scrydex for OP01-120 (foil/alt-art/manga as
   separate priced rows) and a Pokémon multi-printing card (reverse-holo/holo separate).

### Credit facts (from Phase 0, confirmed)
- Re-ingest is FREE of EXTRA Scrydex calls (printings already in the pages pulled): ~29 credits
  One Piece + ~475 Pokémon = ~504, same as the original pull. Owner HAS Scrydex credits.
- The limiting factor is AGENT/session budget — run the build as its own fresh session.
