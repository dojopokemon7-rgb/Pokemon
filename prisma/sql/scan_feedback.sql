-- =============================================================
-- ScanFeedback table (F-14 recognition tuning loop)
-- =============================================================
-- One row per completed scan: OCR text, the ranked candidates offered, and
-- the card the user finally picked. Ground truth for tuning the scoring
-- weights in src/lib/services/card-recognition.service.ts.
--
-- Applying
-- -------------------------------------------------------------
--   npx prisma db execute --file prisma/sql/scan_feedback.sql --schema prisma/schema.prisma
--
-- Idempotent (IF NOT EXISTS), safe to re-run, non-destructive.
-- =============================================================

CREATE TABLE IF NOT EXISTS "scan_feedback" (
  "id"           TEXT NOT NULL,
  "userId"       TEXT,
  "ocrText"      TEXT NOT NULL,
  "ocrSource"    TEXT NOT NULL DEFAULT 'vision',
  "candidates"   JSONB NOT NULL,
  "pickedCardId" TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "scan_feedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "scan_feedback_userId_idx"       ON "scan_feedback" ("userId");
CREATE INDEX IF NOT EXISTS "scan_feedback_pickedCardId_idx" ON "scan_feedback" ("pickedCardId");
CREATE INDEX IF NOT EXISTS "scan_feedback_createdAt_idx"    ON "scan_feedback" ("createdAt");
