# `ingest-onepiece-catalog.ts` — full One Piece catalog ingest (OWNER-RUN)

## What it does

Ingests the **entire** Scrydex One Piece catalog — every card plus every
variant's images — into the `Card`/`CardSet` tables so the catalog is complete
and the scanner can match **any** One Piece card. It pages the Scrydex
catalog-list endpoint

```
GET /onepiece/v1/cards?q=&include=prices&pageSize=100&page=N
```

reads `total_count` to size the run, and per-card upserts a `Card` keyed by
`externalId` = the Bandai code (e.g. `OP08-023`).

This **supersedes** the thin ~45-query name-seed for One Piece
(`prisma/seed.ts onePieceQueries`), which only populated a few hundred cards and
missed alt-art variant images. That thin seed is the reason One Piece scanning
was less accurate than Pokémon; a complete catalog is the fix.

## Scope

**One Piece only.** The Pokémon catalog, seed, and ingest paths are untouched.
Every card lands in a `onepiece-<slug(setName)>` set (the existing convention,
set name from the card's `expansion.name`) and the upsert sets
`game: ONE_PIECE` **explicitly** on both create and update (the schema default
is `POKEMON` and no existing OP write path set it — ingested rows are now
correctly tagged).

Per-card mapping:

- `number` via `deriveStoredCardNumber(id, true)` → the **full Bandai code**
  (matches the scanner's normalized parse).
- base `imageUrl`, `rarity`, `types` when present.
- `marketPrice` only when Scrydex returns a real raw price (`pickRawPrice`) —
  never fabricated; absent → `null` → UI renders "—".
- `variantImages` via `pickVariantImages()` — real `images.scrydex.com` URLs
  only; written only when non-empty so a prior backfilled map is never clobbered.
- each card is validated through `NormalizedCardSchema`; invalid cards (no name,
  no usable image) are logged and **dropped** (RULE 2), never placeheld.

## Credit estimate

Cost is **per request (page)**, not per card:

```
pages = ceil(total_count / 100)   # ~2840 cards → ceil(2840/100) = 29 pages
credits ≈ 29 (budget ~35 with retry margin)
```

The dry run prints the exact estimate from the live `total_count`.

## Credit gate (DENY by default)

Every live, credit-consuming call is gated by
`assertScrydexCreditsApproved("standard", pageCount)`. Approve the spend via
**either**:

- env `SCRYDEX_LIVE_CREDITS_APPROVED=true` (operator run), or
- the admin Redis flag `scrydex:credit-approval`.

**Dry run also makes ONE gated page-1 fetch** (to read `total_count`), so even
the dry run requires approval before that single live call.

The script is **never auto-run** in build/verify and makes **no live Scrydex
call** during build/verify.

## Commands (PowerShell — the worktree path contains a space, quote it)

```powershell
cd "d:\Pokemon\Pokemon\.worktrees\op-ingest"

# DRY RUN (default): 1 gated page-1 fetch → total_count + 5-card sample +
# credit estimate. NO writes.
npx tsx scripts/ingest-onepiece-catalog.ts

# After owner approval + SCRYDEX_LIVE_CREDITS_APPROVED=true: full paged ingest.
npx tsx scripts/ingest-onepiece-catalog.ts --apply
```

Run against the **Mumbai** database (the configured `DATABASE_URL`). This is an
orchestrator/owner-run one-off, not a cron job.

## Idempotency + rollback

- **Idempotent:** upsert is keyed by `externalId`. A re-run of the same catalog
  compares every mapped field (incl. a canonical variant-images equality) and
  reports `created / updated / skipped`; a clean re-run is all `skipped`.
- **Rollback:** every ingested row is scoped by `set.externalId` starting with
  `onepiece-`, so a bad run is reversible by deleting the affected One Piece
  rows (and, if desired, the `onepiece-*` sets) — **no Pokémon impact**.
