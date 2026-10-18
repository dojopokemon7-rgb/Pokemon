# APPLY — 20250112000000_card_per_printing_model

**DO NOT run this against the Mumbai DB in any build/verify step.** The migration
is authored here and applied by the OWNER/orchestrator. There is no live DB in
the build sandbox.

## What it does

Per-printing catalog re-model — additive column + index swap on `card`:

```sql
ALTER TABLE "card" ADD COLUMN IF NOT EXISTS "printing" TEXT;
UPDATE "card" SET "printing" = 'normal' WHERE "printing" IS NULL;
DROP INDEX IF EXISTS "card_scrydexId_key";
CREATE INDEX IF NOT EXISTS "card_scrydexId_idx" ON "card" ("scrydexId");
```

- `printing` (nullable TEXT): verbatim Scrydex `variants[].name`, backfilled to
  `'normal'` for every existing row.
- `scrydexId` loses its UNIQUE constraint (`card_scrydexId_key` dropped) because
  one Scrydex card now expands to many rows; a plain `card_scrydexId_idx` keeps
  lookups index-seeked.
- `number` has NO uniqueness to drop. `externalId` STAYS `@unique` — the
  `${baseId}::${name}` per-printing composite key rides it. No column drops, no
  type narrowing — **non-destructive**.

## Preferred apply command (owner / orchestrator)

```sh
# DATABASE_URL must point at the Mumbai read/write connection string.
# Prisma CLI MUST be pinned to v6 — plain `npx prisma` fetches a v8 RC.
npx -y prisma@6 migrate deploy
```

`migrate deploy` runs only pending migrations in order and records this one in
`_prisma_migrations`. It is idempotent (`IF (NOT) EXISTS` everywhere).

## Docker raw fallback (psql not on PATH)

```sh
# PGPASSWORD and the connection string come from the environment / secrets store,
# NOT from this file. $DATABASE_URL is the Mumbai read/write conn string.
docker run --rm -i -e PGPASSWORD="$PGPASSWORD" postgres:17-alpine \
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  < prisma/migrations/20250112000000_card_per_printing_model/migration.sql
```

## Verify after apply (against the live DB)

```sql
-- Expect exactly one row: the new column exists.
SELECT column_name FROM information_schema.columns
WHERE table_name = 'card' AND column_name = 'printing';

-- Inspect the index list: expect `card_scrydexId_idx` (non-unique) present and
-- `card_scrydexId_key` (unique) ABSENT; `card_externalId_key` (unique) KEPT.
\d card
```

## Rollback

```sql
DROP INDEX IF EXISTS "card_scrydexId_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "card_scrydexId_key" ON "card" ("scrydexId");
ALTER TABLE "card" DROP COLUMN "printing";
```

A rollback is safe only before per-printing rows are ingested (once non-base
`${baseId}::${name}` rows exist, re-adding the `scrydexId` UNIQUE will fail on
the shared ids — delete the non-base rows first).
