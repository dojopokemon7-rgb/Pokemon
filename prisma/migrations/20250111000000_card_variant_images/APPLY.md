# APPLY — 20250111000000_card_variant_images

**DO NOT run this against Mumbai in any build/verify step.** The migration was
authored and verified locally against a throwaway `postgres:17-alpine` only. The
orchestrator applies it to the real DB. There is no live DB in the build sandbox.

## What it does

Adds one **additive, nullable** `JSONB` column `variantImages` to `card`:

```sql
ALTER TABLE "card" ADD COLUMN IF NOT EXISTS "variantImages" JSONB;
```

Display-only per-variant image map (keyed by Scrydex variant name →
`{ small?, medium?, large? }` of images.scrydex.com URLs). Written ONLY for One
Piece cards, ONLY when non-empty, by the single Scrydex price writer. No backfill
of data, no drops, no type narrowing — **non-destructive**.

## Preferred apply command (orchestrator)

```sh
# DATABASE_URL must point at the Mumbai read/write connection string.
npx prisma migrate deploy
```

`migrate deploy` runs only pending migrations in order and records this one in
`_prisma_migrations`. It is idempotent (`ADD COLUMN IF NOT EXISTS`).

## Docker raw fallback (psql not on PATH)

If `prisma migrate deploy` cannot be used, pipe the SQL through psql in the
`postgres:17-alpine` image. Supply the password via `PGPASSWORD` and the Mumbai
connection string — **never embed real credentials in this file or in git**:

```sh
# PGPASSWORD and the connection string come from the environment / secrets store,
# NOT from this file. $DATABASE_URL is the Mumbai read/write conn string.
docker run --rm -i -e PGPASSWORD="$PGPASSWORD" postgres:17-alpine \
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  < prisma/migrations/20250111000000_card_variant_images/migration.sql
```

## Verify after apply (against the live DB)

```sql
-- Expect exactly one row: the new column exists.
SELECT column_name FROM information_schema.columns
WHERE table_name = 'card' AND column_name = 'variantImages';
```

## Rollback

```sql
ALTER TABLE "card" DROP COLUMN "variantImages";
```

A rollback loses only re-derivable display URLs (re-populate via
`scripts/backfill-onepiece-variant-images.ts`), no source-of-truth data.
