# APPLY — 20250114000000_sold_listing_variant

**DO NOT run this against the Mumbai DB in any build/verify step.** The migration
is authored here and applied by the OWNER/orchestrator. There is no live DB in
the build sandbox.

## What it does

Per-printing re-model — additive, nullable column on `sold_listing`:

```sql
ALTER TABLE "sold_listing" ADD COLUMN IF NOT EXISTS "variant" TEXT;
```

- `variant` (nullable TEXT): the Scrydex `variant` a sold record belongs to.
  The sold-listings writer (`pullAndStoreSoldListings`) STORE-SCOPES records to
  the card row's printing variant before upsert, so a plain `where { cardId }`
  read is already printing-correct — the column is stored for provenance /
  debuggability and leaves a store-all-filter-on-read upgrade path open without
  another migration.
- No backfill (existing rows keep `NULL` — honest; they predate per-printing
  scoping). No index change, no type narrowing — **non-destructive**.

## Preferred apply command (owner / orchestrator)

```sh
# DATABASE_URL must point at the Mumbai read/write connection string.
# Prisma CLI MUST be pinned to v6 — plain `npx prisma` fetches a v8 RC.
npx -y prisma@6 migrate deploy
```

`migrate deploy` runs only pending migrations in order and records this one in
`_prisma_migrations`. It is idempotent (`IF NOT EXISTS`).

## Docker raw fallback (psql not on PATH)

```sh
# PGPASSWORD and the connection string come from the environment / secrets store,
# NOT from this file. $DATABASE_URL is the Mumbai read/write conn string.
docker run --rm -i -e PGPASSWORD="$PGPASSWORD" postgres:17-alpine \
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  < prisma/migrations/20250114000000_sold_listing_variant/migration.sql
```

## Verify after apply (against the live DB)

```sql
-- Expect exactly one row: the new column exists.
SELECT column_name FROM information_schema.columns
WHERE table_name = 'sold_listing' AND column_name = 'variant';
```

## Rollback

```sql
ALTER TABLE "sold_listing" DROP COLUMN IF EXISTS "variant";
```

A rollback is safe: the column is additive and nullable, so dropping it loses
only the per-printing provenance annotation (the store-scoped rows remain
correctly scoped by `cardId`).
