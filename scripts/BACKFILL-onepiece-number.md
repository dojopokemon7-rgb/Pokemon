# Backfill: One Piece `Card.number` → full Bandai code

OWNER-RUN. Fixes the One Piece scanner "card not recognized" bug for rows that
were seeded/added before the game-gated number fix. Those rows store the bare
tail (`"064"`); the recognizer parses and normalizes the full code
(`"op01-064"`), so the `+50` number signal never fires and every One Piece card
falls under the 0.4 confidence gate. This backfill sets
`Card.number = Card.externalId` (the full Bandai code) for One Piece rows only.

## What it touches

- **One Piece cards ONLY** — rows whose `set.externalId` starts with
  `"onepiece-"`. Pokémon rows are never selected, and every write re-checks the
  One Piece set scope, so a Pokémon row can never be touched.
- Only `Card.number`. Never `externalId`, prices, or any other column.
- **No credits, no network, no Scrydex calls** — it copies `externalId` (already
  in the DB) into `number`.

## Idempotency

Only rows where `number !== externalId` are selected, so running twice is a
no-op. The second run reports `needingFix=0`.

## Run commands (PowerShell — quote the space in the repo path)

```powershell
cd "d:\Pokemon\Pokemon\.worktrees\scan-opnumber"

# DRY RUN (default): prints total One Piece count, how many need fixing, and a
# sample of 5 before -> after. Makes NO writes.
npx tsx scripts/backfill-onepiece-number.ts

# APPLY: set number = full Bandai code for the One Piece rows that need it.
npx tsx scripts/backfill-onepiece-number.ts --apply
```

Run against the Mumbai `DATABASE_URL` (the live Supabase/Postgres the app uses).

## Rollback

No manifest is needed: `externalId` is never mutated and the previous value was
losslessly derivable as the post-hyphen tail
(`externalId.split("-").pop()`, e.g. `"OP01-064"` → `"064"`). If a revert is
ever required, run a one-off that re-derives the bare tail for One Piece rows.

## Option B (SKIPPED — recommendation only)

The findings proposed a second, independent robustness change: in
`computeConfidence` (`src/lib/services/card-recognition.service.ts`), drop
`WEIGHTS.number` from the `achievable` denominator when NO candidate matched the
parsed number — parallel to how `set` is only counted when `setAchievable`.

**Not implemented.** The game-gated A1 fix alone restores One Piece recognition
(the number now matches → `+50` fires → confidence clears 0.4) without touching
the Pokémon-shared scoring path. Dropping the number weight is shared scoring
that also affects Pokémon and would let a strong name-only match (no number
parsed/matched) surface as a confident guess, raising the false-positive risk.
Left as a future hedge, to be weighed against false positives on real hardware
OCR before adopting.
