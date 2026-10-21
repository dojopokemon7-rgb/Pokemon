-- Bug B — PricingHistory RAW-row de-dupe + partial unique index (per-day).
-- =============================================================================
-- WHY
-- -----------------------------------------------------------------------------
-- PricingHistory's modeled constraint is
--   @@unique([cardId, recordedAt, source, currency, variant, condition,
--             company, grade, type])
-- Postgres treats NULLs as DISTINCT in a unique index, so RAW rows — where
-- `company` AND `grade` are both NULL — can NEVER collide: every (NULL, NULL)
-- pair is "different" from every other. `createMany(skipDuplicates:true)` in
-- `pullAndStoreScrydexHistory` therefore NEVER skips a raw point, so each enrich
-- re-pull of the documented `/price_history` endpoint DUPLICATES every raw NM
-- day it already stored (audit 01 P-01 / audit 09 F1 / R-01). This mirrors the
-- dedupe-then-constrain + partial-unique + DO $$ self-check pattern of the
-- sibling migration 20250110000000_current_price_raw_dedupe (`cp_raw_coalesced`).
--
-- PER-DAY IDENTITY — why `recordedAt` is used DIRECTLY (no date truncation):
-- the history writer stores each raw NM point with
--   recordedAt = parseHistoryDate(day.date)
-- which parses Scrydex "YYYY/MM/DD" to UTC MIDNIGHT of that day
-- (`T00:00:00.000Z`). Every point for a given day therefore shares the SAME
-- midnight timestamp, so the per-day identity is already expressed by
--   (cardId, recordedAt, source, currency, variant, condition, type)
-- restricted to RAW rows — the raw analogue of the 9-column @@unique minus the
-- two NULL columns (company/grade), exactly like `cp_raw_coalesced`'s shape
-- (the partial WHERE pins company/grade to NULL, so they drop out of the
-- indexed column list).
--
-- CAVEAT (intended scope): the OTHER raw writer, `pullAndStoreScrydexPrice`,
-- writes its single current point with `recordedAt = now` (an EXACT sub-second
-- timestamp, NOT midnight). Those points never collide with each other across
-- pulls, so this partial index does NOT dedupe the daily current-point writer —
-- and must not: it targets the `/price_history` raw-NM re-pull duplication (the
-- path on-view enrich uses). The index enforces AT-MOST-ONE raw point per
-- (card, day, source, currency, variant, condition, type); history points are
-- the only raw writer keyed to a day, so this is correct and intended.
--
-- The partial unique index `ph_raw_coalesced` is RAW-SQL-ONLY (intentionally
-- NOT an @@index in schema.prisma — Prisma cannot model a partial WHERE index),
-- the same precedent as `cp_raw_coalesced` / `uc_variant_coalesced`. GRADED
-- rows (non-null company/grade) fall outside the WHERE and remain governed
-- solely by the existing full @@unique; they are never selected, deleted, or
-- constrained here.
--
-- ORDER MATTERS: dedupe RAW rows first (keep newest per group), THEN add the
-- RAW partial unique.
--
-- APPLY (orchestrator only — NEVER auto-run against the live DB in any step):
--   npx prisma migrate deploy
-- See APPLY.md in this directory for the exact command + Docker-psql fallback.
-- This file only AUTHORS the migration; there is no live DB in the build sandbox.
--
-- IDEMPOTENT: the DELETE is a no-op once de-duped, and the index uses IF NOT
-- EXISTS, so a repeat `migrate deploy` is safe.

-- STEP 1 — de-dup RAW rows ONLY.
-- Logical raw group key = (cardId, recordedAt, source, currency, variant,
-- condition, type) restricted to RAW rows via `WHERE company IS NULL AND grade
-- IS NULL`. That guard GUARANTEES no graded row (non-null company/grade) is ever
-- selected or deleted. Survivor rule: newest recordedAt wins; lowest id breaks
-- ties. Losers (rn>1) go. (For history points recordedAt is identical within a
-- day group, so the id tiebreak decides the survivor — a stable, harmless pick
-- since the duplicate points carry the same real value.)
WITH grp AS (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY k ORDER BY "recordedAt" DESC, "id" ASC) AS rn
  FROM (
    SELECT *,
      ("cardId" || '|' || "recordedAt"::text || '|' || "source"
        || '|' || "currency" || '|' || "variant" || '|' || "condition"
        || '|' || "type") AS k
    FROM "pricing_history"
    WHERE "company" IS NULL AND "grade" IS NULL
  ) s
)
DELETE FROM "pricing_history" ph
  USING grp g
  WHERE ph.id = g.id AND g.rn > 1;

-- STEP 2 — partial unique index on RAW rows only.
-- Plain-columns + partial WHERE (not a COALESCE expression index): the partial
-- predicate already pins company/grade to NULL, so there are no NULLs left among
-- the indexed columns to collapse; the minimal correct form is the plain-column
-- list. This is the RAW analogue of `cp_raw_coalesced`. GRADED rows fall outside
-- the WHERE and remain governed solely by the existing full @@unique.
CREATE UNIQUE INDEX IF NOT EXISTS "ph_raw_coalesced"
  ON "pricing_history" (
    "cardId",
    "recordedAt",
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
    SELECT 1 FROM "pricing_history"
    WHERE "company" IS NULL AND "grade" IS NULL
    GROUP BY "cardId", "recordedAt", "source", "currency", "variant", "condition", "type"
    HAVING COUNT(*) > 1
  ) d;
  IF dupes > 0 THEN RAISE EXCEPTION 'ph_raw dedupe failed: % groups remain', dupes; END IF;
END $$;
