-- F-#8 Per-Collection 5-Bucket Collection Model
-- =============================================================
-- This is the FIRST real migration (the project previously used `db push`).
-- It is hand-augmented over the Prisma-generated delta so it is idempotent and
-- NEVER fails on real duplicate data. ORDER MATTERS: dedupe first, then constrain.
--
-- The Prisma-modeled delta is: add WantListItem.collectionId + FK (SetNull),
-- add @@index([userId,collectionId,intent]), drop old @@unique([userId,cardId,intent]).
-- The two COALESCE partial expression indexes (uc_variant_coalesced,
-- wli_scope_coalesced) are NOT modelable in Prisma schema, so they are created
-- here explicitly and are the SOLE enforcement of per-variant / per-scope uniqueness.

-- STEP 1 — additive column + FK (safe, nullable, no backfill needed).
-- Every pre-existing row keeps collectionId = NULL by definition (AC-2).
ALTER TABLE "want_list_item" ADD COLUMN "collectionId" TEXT;
ALTER TABLE "want_list_item"
  ADD CONSTRAINT "want_list_item_collectionId_fkey"
  FOREIGN KEY ("collectionId") REFERENCES "collection"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- STEP 2 — DEDUPE UserCollection BEFORE adding its unique (AC-5).
-- Merge rule (D-5): within each variant group, the OLDEST addedAt lot survives;
-- its quantity becomes the group's summed quantity; the losers are deleted.
--
-- COST-BASIS CONSEQUENCE (explicit, lossy by design): we SET only the survivor's
-- quantity and never touch its purchasePrice/costBasis* columns, so the merged lot
-- keeps the SURVIVOR's per-copy basis for the full summed quantity. The losers'
-- purchasePrice is DISCARDED — the user's blended "Paid"/realized-P&L for this
-- variant collapses to the oldest lot's per-copy figure. This is a deliberate,
-- documented LOSSY collapse (NOT a weighted average): true DB duplicates were never
-- supposed to exist (no constraint prevented them until now), so there is no correct
-- blended basis to preserve, and collapsing to the earliest provenance is simplest.
-- Only the survivor's own basis is preserved — this is NOT provenance-preserving.
--
-- SOLD ROWS: dedupe is restricted to isSold=false. Sold rows (isSold=true) are
-- intentionally NOT merged — each sale is a distinct historical lot, and the partial
-- uc_variant_coalesced index (Step 3, WHERE isSold=false) excludes them, so
-- pre-existing sold duplicates can never violate the new constraint.
--
-- Grouping normalizes both nullable columns with the '' sentinel so loose/raw lots
-- group the same way the new index will enforce.
WITH grp AS (
  SELECT
    id,
    SUM("quantity") OVER (PARTITION BY k) AS merged_qty,
    ROW_NUMBER()    OVER (PARTITION BY k ORDER BY "addedAt" ASC, "id" ASC) AS rn
  FROM (
    SELECT *,
      ("userId" || '|' || COALESCE("collectionId", '') || '|' || "cardId"
        || '|' || "isFoil"::text || '|' || COALESCE("condition", '')) AS k
    FROM "user_collection"
    WHERE "isSold" = false
  ) s
)
UPDATE "user_collection" u
  SET "quantity" = g.merged_qty
  FROM grp g
  WHERE u.id = g.id AND g.rn = 1;

WITH grp AS (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY k ORDER BY "addedAt" ASC, "id" ASC) AS rn
  FROM (
    SELECT *,
      ("userId" || '|' || COALESCE("collectionId", '') || '|' || "cardId"
        || '|' || "isFoil"::text || '|' || COALESCE("condition", '')) AS k
    FROM "user_collection"
    WHERE "isSold" = false
  ) s
)
DELETE FROM "user_collection" u
  USING grp g
  WHERE u.id = g.id AND g.rn > 1;

-- STEP 3 — expression unique indexes (D-1). Partial on isSold=false so sold
-- lots (which legitimately repeat per sale) are never constrained.
CREATE UNIQUE INDEX "uc_variant_coalesced"
  ON "user_collection" (
    "userId",
    COALESCE("collectionId", ''),
    "cardId",
    "isFoil",
    COALESCE("condition", '')
  )
  WHERE "isSold" = false;

CREATE UNIQUE INDEX "wli_scope_coalesced"
  ON "want_list_item" (
    "userId",
    "cardId",
    "intent",
    COALESCE("collectionId", '')
  );

-- STEP 4 — drop the OLD global want-list unique it replaces (Prisma emits this).
DROP INDEX IF EXISTS "want_list_item_userId_cardId_intent_key";

-- STEP 5 — supporting index for the new per-collection want query (Prisma-modeled).
CREATE INDEX "want_list_item_userId_collectionId_intent_idx"
  ON "want_list_item" ("userId", "collectionId", "intent");

-- STEP 6 — self-check: after dedupe+index, zero variant groups have >1 active lot.
DO $$
DECLARE dupes INT;
BEGIN
  SELECT COUNT(*) INTO dupes FROM (
    SELECT 1 FROM "user_collection"
    WHERE "isSold" = false
    GROUP BY "userId", COALESCE("collectionId", ''), "cardId", "isFoil", COALESCE("condition", '')
    HAVING COUNT(*) > 1
  ) d;
  IF dupes > 0 THEN RAISE EXCEPTION 'uc_variant dedupe failed: % groups remain', dupes; END IF;
END $$;
