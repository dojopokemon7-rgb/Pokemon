-- Fix 4 — CurrentPrice RAW-row de-dupe + partial unique index (catalog-wide).
-- =============================================================================
-- WHY
-- -----------------------------------------------------------------------------
-- CurrentPrice's modeled constraint is
--   @@unique([cardId, source, currency, variant, condition, company, grade, type])
-- Postgres treats NULLs as DISTINCT in a unique index, so RAW rows — where
-- `company` AND `grade` are both NULL — can NEVER collide: every (NULL, NULL)
-- pair is "different" from every other. The investigation found ~16,349 duplicate
-- RAW groups (~16,549 extra rows). GRADED rows (non-null company/grade) have 0
-- duplicates and MUST NOT be touched by this migration.
--
-- This mirrors the dedupe-then-constrain + COALESCE/partial-unique + DO $$
-- self-check pattern established by 20250101000000_collection_buckets and the
-- raw-SQL-only index precedent of 20250106000000_pg_trgm_search_indexes.
--
-- The partial unique index `cp_raw_coalesced` is RAW-SQL-ONLY (intentionally NOT
-- an @@index in schema.prisma — Prisma cannot model a partial WHERE index), the
-- same way the trigram GIN indexes and uc_variant_coalesced live only here.
-- GRADED rows keep the existing full @@unique; they are untouched.
--
-- ORDER MATTERS: dedupe RAW rows first, then add the RAW partial unique.
--
-- APPLY (orchestrator only — NEVER auto-run against Mumbai in any step):
--   npx prisma migrate deploy
-- See APPLY.md in this directory for the exact command + Docker-psql fallback.
-- This file only AUTHORS the migration; there is no live DB in the build sandbox.
--
-- IDEMPOTENT: the DELETE is a no-op once de-duped, and the index uses IF NOT
-- EXISTS, so a repeat `migrate deploy` is safe.

-- STEP 1 — de-dup RAW rows ONLY.
-- Logical raw group key = (cardId, source, currency, variant, condition, type)
-- restricted to RAW rows via `WHERE company IS NULL AND grade IS NULL`. That guard
-- GUARANTEES no graded row (non-null company/grade) is ever selected or deleted.
-- Survivor rule: newest updatedAt wins; lowest id breaks ties. Losers (rn>1) go.
-- The group key is built with the ||/COALESCE(...,'') sentinel style from
-- collection_buckets (defensive — company/grade are already NULL under the guard,
-- but the sentinel keeps the key-building style identical and NULL-safe).
WITH grp AS (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY k ORDER BY "updatedAt" DESC, "id" ASC) AS rn
  FROM (
    SELECT *,
      ("cardId" || '|' || "source"::text || '|' || "currency"
        || '|' || "variant" || '|' || "condition" || '|' || "type") AS k
    FROM "current_price"
    WHERE "company" IS NULL AND "grade" IS NULL
  ) s
)
DELETE FROM "current_price" cp
  USING grp g
  WHERE cp.id = g.id AND g.rn > 1;

-- STEP 2 — partial unique index on RAW rows only.
-- Plain-columns + partial WHERE (not a COALESCE expression index): because the
-- partial predicate itself already pins company/grade to NULL, there are no
-- NULLs left among the indexed columns to collapse, so the minimal correct form
-- is the plain-column list. This is the RAW analogue of uc_variant_coalesced /
-- wli_scope_coalesced (both partial unique indexes created in raw SQL here);
-- GRADED rows fall outside the WHERE and remain governed solely by the existing
-- full @@unique.
CREATE UNIQUE INDEX IF NOT EXISTS "cp_raw_coalesced"
  ON "current_price" (
    "cardId",
    "source",
    "currency",
    "variant",
    "condition",
    "type"
  )
  WHERE "company" IS NULL AND "grade" IS NULL;

-- STEP 3 — self-check: after dedupe+index, zero RAW groups have >1 row.
DO $$
DECLARE dupes INT;
BEGIN
  SELECT COUNT(*) INTO dupes FROM (
    SELECT 1 FROM "current_price"
    WHERE "company" IS NULL AND "grade" IS NULL
    GROUP BY "cardId", "source", "currency", "variant", "condition", "type"
    HAVING COUNT(*) > 1
  ) d;
  IF dupes > 0 THEN RAISE EXCEPTION 'cp_raw dedupe failed: % groups remain', dupes; END IF;
END $$;
