# Backfill: One Piece `Card.variantImages` (alt-art fix)

OWNER-RUN. Populates the per-variant image map for existing One Piece cards so
the card-detail hero can show the SELECTED variant's real art (fixing the
ALTERNATE-ART variant showing the base image). The ingest writer only fills
`variantImages` on a priced Scrydex pull; this one-pass backfill fills the
existing catalog after owner approval.

## What it touches

- **One Piece cards ONLY** — rows whose `set.externalId` starts with
  `"onepiece-"`. Pokémon rows are never selected, and every write re-checks the
  One Piece set scope, so a Pokémon row can never be touched.
- Only `Card.variantImages`. Never `externalId`, prices, or any other column.

## Credits + gating (LIVE calls on `--apply`)

- The Scrydex catalog resolve/by-id call costs **~1 credit per card**. The DRY
  RUN prints the exact estimate (`estimateCredits("standard", cardCount)`).
- **DENY by default.** Before any live call the script calls
  `assertScrydexCreditsApproved("standard", cardCount)` from
  `src/lib/services/scrydex-credit-gate.ts`. Approve via env
  `SCRYDEX_LIVE_CREDITS_APPROVED=true` or the admin Redis flag
  `scrydex:credit-approval`. Never bypass it.
- **DRY RUN makes NO network calls, NO writes, NO credit spend** — it counts
  from the DB only and prints a credit estimate + a 5-row sample.

## Idempotency

The new map is compared to the stored map via a canonical, key-sorted stringify
that treats `{}` ≡ `null` as equal, so a no-change card is a no-op (reported as
`unchanged`). This backfill is the **sole null-clearer**: a card whose Scrydex
images are now empty is cleared to `null` (the price writer never writes null).

## Run commands (PowerShell — quote the space in the repo path)

```powershell
cd "d:\Pokemon\Pokemon\.worktrees\op-altart"

# DRY RUN (default): One Piece count + credit estimate + sample. No network, no writes.
npx tsx scripts/backfill-onepiece-variant-images.ts

# APPLY (after owner approval): live fetch + write.
$env:SCRYDEX_LIVE_CREDITS_APPROVED = "true"
npx tsx scripts/backfill-onepiece-variant-images.ts --apply
```

Run against the Mumbai `DATABASE_URL` (the live Supabase/Postgres the app uses).

## Rollback

Re-running resolves the map again from the Scrydex catalog, so a bad write is
corrected by a re-run. A `null`-clear is reversible by a re-run (which re-fetches
and re-populates any variant that still has images). No manifest needed — the
source value (Scrydex catalog) is authoritative and re-derivable.
