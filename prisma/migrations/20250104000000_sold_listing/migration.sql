-- Part D — real eBay SOLD records store (SoldListing).
-- DDL names (table / pkey / indexes / FK) are Prisma's own output, verified via
--   `prisma migrate diff --from-empty --to-schema-datamodel ... --script`; the
--   IF NOT EXISTS / DO $$ guards are hand-added for idempotency (modelled on
--   20250102000000_population_report). A later remote `prisma migrate` sees no
--   drift because the constraint/index names match Prisma's.
-- PURELY ADDITIVE: a new table + its indexes + FK. No existing row is touched,
--   no backfill, no dedupe. ZERO credits, LOCAL-only this phase.
CREATE TABLE IF NOT EXISTS "sold_listing" (
  "id"        TEXT NOT NULL,
  "cardId"    TEXT NOT NULL,
  "source"    TEXT,
  "itemId"    TEXT NOT NULL,
  "title"     TEXT,
  "price"     DOUBLE PRECISION,
  "currency"  TEXT,
  "soldAt"    TIMESTAMP(3),
  "grade"     TEXT,
  "company"   TEXT,
  "url"       TEXT,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sold_listing_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "sold_listing_cardId_itemId_key"
  ON "sold_listing" ("cardId", "itemId");

CREATE INDEX IF NOT EXISTS "sold_listing_cardId_soldAt_idx"
  ON "sold_listing" ("cardId", "soldAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sold_listing_cardId_fkey'
  ) THEN
    ALTER TABLE "sold_listing"
      ADD CONSTRAINT "sold_listing_cardId_fkey"
      FOREIGN KEY ("cardId") REFERENCES "card"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
