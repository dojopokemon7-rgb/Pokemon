-- CGC grading "notify me" list (landing /grading-services -> POST /api/grading/notify).
-- ADDITIVE + idempotent: creates one new table, touches nothing existing.
-- Operator applies this MANUALLY to BOTH schemas (public, staging); object names
-- are unqualified on purpose so the session search_path decides the schema.
-- See docs/ARCHITECTURE.md "Grading-interest migration runbook".
CREATE TABLE IF NOT EXISTS "grading_interest" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "volume" TEXT NOT NULL,
    "source" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),
    CONSTRAINT "grading_interest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "grading_interest_category_check" CHECK ("category" IN ('cards', 'comics', 'both')),
    CONSTRAINT "grading_interest_volume_check" CHECK ("volume" IN ('1-10', '11-50', '51-200', '200+')),
    CONSTRAINT "grading_interest_email_lower_check" CHECK ("email" = lower("email"))
);

CREATE UNIQUE INDEX IF NOT EXISTS "grading_interest_email_key" ON "grading_interest"("email");

CREATE INDEX IF NOT EXISTS "grading_interest_joinedAt_idx" ON "grading_interest"("joinedAt");
