# APPLY — 20250110000000_current_price_raw_dedupe

**DO NOT run this against Mumbai in any build/verify step.** The migration was
authored and verified locally against a throwaway `postgres:17-alpine` only. The
orchestrator applies it to the real DB. There is no live DB in the build sandbox.

## What it does

1. De-duplicates **RAW** `current_price` rows (`company IS NULL AND grade IS NULL`)
   down to one survivor per logical group `(cardId, source, currency, variant,
   condition, type)` — newest `updatedAt`, lowest `id` tiebreak. ~16,349 raw dup
   groups (~16,549 extra rows) collapse.
2. Adds partial unique index `cp_raw_coalesced` so raw duplicates cannot recur.
3. **GRADED rows (non-null company/grade) are never selected, deleted, or
   constrained** — they keep the existing full `@@unique`.

## Preferred apply command (orchestrator)

```sh
# DATABASE_URL must point at the Mumbai read/write connection string.
npx prisma migrate deploy
```

`migrate deploy` runs only pending migrations in order and records this one in
`_prisma_migrations`. It is idempotent (DELETE no-ops once de-duped; index uses
`IF NOT EXISTS`; STEP 3 self-check RAISEs only if dedupe failed).

## Docker raw fallback (psql not on PATH)

If `prisma migrate deploy` cannot be used, pipe the SQL through psql in the
`postgres:17-alpine` image. Supply the password via `PGPASSWORD` and the Mumbai
connection string — **never embed real credentials in this file or in git**:

```sh
# PGPASSWORD and the connection string come from the environment / secrets store,
# NOT from this file. $DATABASE_URL is the Mumbai read/write conn string.
docker run --rm -i -e PGPASSWORD="$PGPASSWORD" postgres:17-alpine \
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  < prisma/migrations/20250110000000_current_price_raw_dedupe/migration.sql
```

`-v ON_ERROR_STOP=1` makes the STEP 3 self-check `RAISE EXCEPTION` abort the run
with a non-zero exit if any raw dup group survives.

## Verify after apply (against the live DB)

```sql
-- Expect 0 rows: no raw group with >1 row remains.
SELECT COUNT(*) FROM (
  SELECT 1 FROM current_price
  WHERE company IS NULL AND grade IS NULL
  GROUP BY "cardId", source, currency, variant, condition, type
  HAVING COUNT(*) > 1
) d;

-- Confirm the partial unique index exists.
SELECT indexname FROM pg_indexes WHERE indexname = 'cp_raw_coalesced';
```
