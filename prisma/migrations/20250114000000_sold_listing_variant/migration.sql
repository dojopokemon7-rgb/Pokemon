-- Per-printing re-model (AGENTS.md RULE 3): add the sold record's Scrydex
-- `variant` so the sold-listings writer can STORE-SCOPE records to a card
-- row's printing. Additive, nullable, idempotent — no backfill, no index
-- change, no type narrowing. NON-DESTRUCTIVE.
ALTER TABLE "sold_listing" ADD COLUMN IF NOT EXISTS "variant" TEXT;
