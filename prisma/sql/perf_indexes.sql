-- =============================================================
-- Performance indexes for search + set filtering
-- =============================================================
-- Rationale
-- -------------------------------------------------------------
-- The card search route (src/app/api/cards/search/route.ts) filters on:
--
--   1. tags: { has: <query> }              -> array membership
--   2. set: { name: { contains, insensitive } }  (F-06 set filter/label)
--   3. set: { externalId: { startsWith } } (game prefix, every search)
--
-- (1) needs a GIN index on the tags[] array — btree can't do array
--     membership, so `has` degrades to a sequential scan without it.
-- (2) `contains` is `ILIKE '%..%'` (leading wildcard) — only a pg_trgm
--     GIN index helps; mirrors the existing card_name_trgm_idx.
-- (3) is a prefix match on card_set.externalId, which is already backed
--     by its UNIQUE btree index — no extra index required.
--
-- Applying
-- -------------------------------------------------------------
--   npx prisma db execute --file prisma/sql/perf_indexes.sql --schema prisma/schema.prisma
--
-- Idempotent (IF NOT EXISTS), safe to re-run, non-destructive.
-- =============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- (1) Array membership on Card.tags (search `tags has <query>`).
CREATE INDEX IF NOT EXISTS card_tags_gin_idx
  ON "card"
  USING gin ("tags");

-- (2) Substring/insensitive match on CardSet.name (F-06 set filter).
CREATE INDEX IF NOT EXISTS card_set_name_trgm_idx
  ON "card_set"
  USING gin (name gin_trgm_ops);
