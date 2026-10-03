-- =============================================================
-- DRAFT MIGRATION — scrydex-migration schema deltas (NOT APPLIED)
-- =============================================================
-- These are the ADDITIVE, backward-compatible column adds introduced for the
-- Dojo production plan. They are all nullable or defaulted, so applying them to
-- an existing database is non-destructive and requires no data backfill to keep
-- the app working (legacy rows read as null/0).
--
-- APPLY PATH (OWNER-APPROVED ONLY): the project uses `prisma db push`
-- (see package.json `db:push`), which syncs schema.prisma to the database using
-- DIRECT_URL. This file documents the exact effect for review. Do NOT run
-- `npm run db:push` against production until the owner approves — it touches the
-- live Supabase database (plan §7.5).
--
-- Equivalent SQL (for review; `prisma db push` generates/executes its own):
-- -------------------------------------------------------------

ALTER TABLE "user"            ADD COLUMN "scanCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "user"            ADD COLUMN "onboardingCompletedAt" TIMESTAMP(3);
ALTER TABLE "user"            ADD COLUMN "displayCurrency" TEXT NOT NULL DEFAULT 'USD';

ALTER TABLE "user_collection" ADD COLUMN "costBasisSource" TEXT;
ALTER TABLE "user_collection" ADD COLUMN "costBasisCurrency" TEXT;
ALTER TABLE "user_collection" ADD COLUMN "costBasisAttemptedAt" TIMESTAMP(3);
ALTER TABLE "user_collection" ADD COLUMN "soldCurrency" TEXT;

ALTER TABLE "pricing_history" ADD COLUMN "sourceCurrency" TEXT;

ALTER TABLE "card"            ADD COLUMN "weeklyChangeAbs" DOUBLE PRECISION;
ALTER TABLE "card"            ADD COLUMN "weeklyChangePct" DOUBLE PRECISION;

-- Optional one-time backfill of sourceCurrency for legacy rows (safe; idempotent):
-- UPDATE "pricing_history" SET "sourceCurrency" = "currency" WHERE "sourceCurrency" IS NULL;

-- NOTE: the fabricated `scrydex-trend` PricingHistory rows (retired this migration)
-- may be cleaned up with the following, ALSO owner-approval-gated and destructive:
--   DELETE FROM "pricing_history" WHERE "source" = 'scrydex-trend';
-- Leaving them in place is harmless (the writer no longer produces them and the
-- history route can be filtered); deletion is a tidy-up, not a correctness need.
