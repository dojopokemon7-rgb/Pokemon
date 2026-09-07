-- =============================================================
-- Postgres trigram (pg_trgm) index for card name search
-- =============================================================
-- Rationale
-- -------------------------------------------------------------
-- The user-facing search hits `prisma.card.findMany` with
--
--     where: { name: { contains: query, mode: "insensitive" } }
--
-- which Postgres executes as `name ILIKE '%<query>%'`. A regular
-- btree index on `name` cannot help that pattern (leading wildcard),
-- so on a catalog of any size it degrades to a sequential scan.
--
-- pg_trgm's GIN index on `name gin_trgm_ops` supports arbitrary
-- substring search efficiently. Once the daily sync fills the
-- catalog (~19k Pokémon cards + ~5k One Piece), this index is the
-- difference between a ~2 ms lookup and a full-table scan.
--
-- Applying
-- -------------------------------------------------------------
--   npx prisma db execute --file prisma/sql/pg_trgm_index.sql --schema prisma/schema.prisma
--
-- Idempotent: CREATE EXTENSION / INDEX IF NOT EXISTS makes this safe
-- to re-run. Ships in the repo so any environment can bootstrap
-- itself the same way.
-- =============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS card_name_trgm_idx
  ON "card"
  USING gin (name gin_trgm_ops);
