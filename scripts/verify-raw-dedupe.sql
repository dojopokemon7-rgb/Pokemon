-- Local verification for Fix 4 (CurrentPrice RAW dedupe + partial unique).
-- Run against a THROWAWAY postgres:17-alpine (psql not on PATH):
--   docker run -d --rm --name cpdedupe -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:17-alpine
--   docker exec -i cpdedupe psql -U postgres -v ON_ERROR_STOP=1 < scripts/verify-raw-dedupe.sql
--   docker rm -f cpdedupe
--
-- ON_ERROR_STOP=1 means any failed ASSERT / unexpected error aborts non-zero.
-- This is the ONE runnable check for Fix 4: it seeds duplicate RAW rows + a
-- distinct raw row + duplicate GRADED rows, runs the migration's STEP 1/2/3,
-- and asserts the exact survivor/graded-untouched/constraint behavior.

-- Minimal current_price table mirroring the real columns the migration touches.
CREATE TABLE current_price (
  id          text PRIMARY KEY,
  "cardId"    text NOT NULL,
  source      text NOT NULL,
  currency    text NOT NULL DEFAULT 'USD',
  variant     text NOT NULL DEFAULT 'normal',
  condition   text NOT NULL DEFAULT 'NM',
  company     text,
  grade       text,
  type        text NOT NULL DEFAULT 'raw',
  "priceMarket" double precision,
  "updatedAt" timestamptz NOT NULL
);

-- 3 identical RAW rows (NULL company/grade), differing updatedAt + id.
-- Expected survivor: newest updatedAt (2024-03-03) => id 'raw-c'.
INSERT INTO current_price (id, "cardId", source, currency, variant, condition, company, grade, type, "priceMarket", "updatedAt") VALUES
  ('raw-a', 'base1-4', 'scrydex', 'USD', 'normal', 'NM', NULL, NULL, 'raw', 10, '2024-01-01'),
  ('raw-b', 'base1-4', 'scrydex', 'USD', 'normal', 'NM', NULL, NULL, 'raw', 11, '2024-02-02'),
  ('raw-c', 'base1-4', 'scrydex', 'USD', 'normal', 'NM', NULL, NULL, 'raw', 12, '2024-03-03');

-- 1 distinct RAW row (different variant) — must remain untouched.
INSERT INTO current_price (id, "cardId", source, currency, variant, condition, company, grade, type, "priceMarket", "updatedAt") VALUES
  ('raw-distinct', 'base1-4', 'scrydex', 'USD', 'holofoil', 'NM', NULL, NULL, 'raw', 50, '2024-01-01');

-- 2 GRADED PSA rows that would be "duplicate" under the raw key but are DISTINCT
-- as graded (different grade). Both must survive — the partial index excludes them.
INSERT INTO current_price (id, "cardId", source, currency, variant, condition, company, grade, type, "priceMarket", "updatedAt") VALUES
  ('grd-10', 'base1-4', 'scrydex', 'USD', 'normal', 'NM', 'PSA', '10', 'graded', 500, '2024-01-01'),
  ('grd-9',  'base1-4', 'scrydex', 'USD', 'normal', 'NM', 'PSA', '9',  'graded', 300, '2024-01-01');

-- =========================================================================
-- MIGRATION STEP 1 — dedupe RAW rows only.
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

-- MIGRATION STEP 2 — partial unique index on RAW rows only.
CREATE UNIQUE INDEX IF NOT EXISTS "cp_raw_coalesced"
  ON "current_price" (
    "cardId", "source", "currency", "variant", "condition", "type"
  )
  WHERE "company" IS NULL AND "grade" IS NULL;

-- MIGRATION STEP 3 — self-check (must NOT raise).
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

-- =========================================================================
-- ASSERTIONS
DO $$
DECLARE
  surv       text;
  surv_price double precision;
  raw_count  int;
  dist_count int;
  grd_count  int;
BEGIN
  -- (1) raw group collapsed to exactly one survivor = newest updatedAt, lowest id.
  SELECT id, "priceMarket" INTO surv, surv_price
  FROM current_price
  WHERE "cardId"='base1-4' AND variant='normal' AND company IS NULL AND grade IS NULL;
  SELECT COUNT(*) INTO raw_count
  FROM current_price
  WHERE "cardId"='base1-4' AND variant='normal' AND company IS NULL AND grade IS NULL;
  IF raw_count <> 1 THEN RAISE EXCEPTION 'ASSERT FAIL: expected 1 raw survivor, got %', raw_count; END IF;
  IF surv <> 'raw-c' THEN RAISE EXCEPTION 'ASSERT FAIL: survivor should be raw-c (newest), got %', surv; END IF;
  IF surv_price <> 12 THEN RAISE EXCEPTION 'ASSERT FAIL: survivor price should be 12, got %', surv_price; END IF;

  -- (2) distinct raw row (different variant) remains.
  SELECT COUNT(*) INTO dist_count FROM current_price WHERE id='raw-distinct';
  IF dist_count <> 1 THEN RAISE EXCEPTION 'ASSERT FAIL: distinct raw row was deleted'; END IF;

  -- (3) BOTH graded rows survive (never selected by the raw guard).
  SELECT COUNT(*) INTO grd_count FROM current_price WHERE type='graded';
  IF grd_count <> 2 THEN RAISE EXCEPTION 'ASSERT FAIL: expected 2 graded rows, got %', grd_count; END IF;

  RAISE NOTICE 'OK: 1 raw survivor (raw-c, price 12), distinct raw kept, 2 graded kept';
END $$;

-- (4) a duplicate RAW insert must now RAISE unique_violation.
DO $$
BEGIN
  INSERT INTO current_price (id, "cardId", source, currency, variant, condition, company, grade, type, "priceMarket", "updatedAt")
  VALUES ('raw-dup-new', 'base1-4', 'scrydex', 'USD', 'normal', 'NM', NULL, NULL, 'raw', 99, '2024-04-04');
  RAISE EXCEPTION 'ASSERT FAIL: duplicate RAW insert was allowed (no unique_violation)';
EXCEPTION
  WHEN unique_violation THEN
    RAISE NOTICE 'OK: duplicate RAW insert correctly rejected (unique_violation)';
END $$;

-- (5) a duplicate GRADED insert must STILL succeed (partial index excludes graded).
DO $$
BEGIN
  INSERT INTO current_price (id, "cardId", source, currency, variant, condition, company, grade, type, "priceMarket", "updatedAt")
  VALUES ('grd-10-dup', 'base1-4', 'scrydex', 'USD', 'normal', 'NM', 'PSA', '10', 'graded', 777, '2024-05-05');
  RAISE NOTICE 'OK: duplicate GRADED insert accepted (graded unaffected by partial index)';
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'ASSERT FAIL: graded insert was blocked by the raw partial index';
END $$;

SELECT 'ALL ASSERTIONS PASSED' AS result;
