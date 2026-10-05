-- Fast case-insensitive substring search (pg_trgm trigram GIN indexes).
--
-- WHY
-- -----------------------------------------------------------------------------
-- The live search path is Postgres (src/app/api/cards/search/route.ts) — the
-- optional Typesense index is OFF unless SEARCH_ENGINE=typesense. That route
-- matches text with Prisma `{ contains, mode: "insensitive" }`, which Postgres
-- executes as `col ILIKE '%term%'`. A plain btree index (card.@@index([name]),
-- card_set.@@index([name])) CANNOT accelerate a leading-wildcard pattern, so at
-- ~47k Pokémon + ~2.8k One Piece cards every keystroke-search degrades to a
-- sequential scan — the main code-side blocker for the client's "<10s to find
-- any card" target.
--
-- pg_trgm's GIN index with the `gin_trgm_ops` operator class makes arbitrary
-- `ILIKE '%term%'` substring search index-accelerated (Bitmap Index Scan
-- instead of Seq Scan). We index exactly the three columns the search route
-- substring-matches:
--   * card.name       — { name: { contains } }           (card + relevance pool)
--   * card.number     — { number: { contains } }         (card number match)
--   * card_set.name   — { set: { name: { contains } } }  (set-name match)
-- The existing btree @@index([name]) indexes are KEPT (they still serve the
-- F-06 `set.name equals` exact filter and ORDER BY name); these are additive.
--
-- APPROACH: raw SQL migration (not the Prisma `postgresqlExtensions` preview
-- feature) because the schema declares no previewFeatures and the repo already
-- ships hand-written idempotent migrations for DDL Prisma can't express
-- cleanly (see 20250102_population_report, 20250104_sold_listing). This is the
-- smaller, lower-risk change and keeps the generator block untouched.
--
-- APPLY to Supabase with:  npx prisma migrate deploy
--   (the orchestrator/user runs this against the real DB; this file only
--    authors the migration. There is no live DB in the build sandbox.)
--
-- VERIFY the index is used (against the live DB, after deploy):
--   EXPLAIN ANALYZE SELECT id FROM card WHERE name ILIKE '%char%';
--   -> should show a "Bitmap Index Scan on card_name_trgm_idx", NOT a "Seq Scan
--      on card". (A tiny table may still prefer a Seq Scan — test on the full
--      ~50k-row catalog.)
--
-- IDEMPOTENT: IF NOT EXISTS on both the extension and every index, so a repeat
-- `migrate deploy` (or an earlier manual `prisma db execute` of the former
-- bootstrap files prisma/sql/pg_trgm_index.sql + perf_indexes.sql, now removed
-- as this migration is the single source for these indexes) is a no-op.
-- CREATE INDEX (no CONCURRENTLY) runs inside the migration's txn.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "card_name_trgm_idx"
  ON "card" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "card_number_trgm_idx"
  ON "card" USING gin ("number" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "card_set_name_trgm_idx"
  ON "card_set" USING gin ("name" gin_trgm_ops);
