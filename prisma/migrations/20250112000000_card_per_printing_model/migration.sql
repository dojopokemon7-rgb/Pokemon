-- Per-printing catalog re-model — add Card.printing + relax scrydexId uniqueness.
-- =============================================================================
-- WHY
-- -----------------------------------------------------------------------------
-- Scrydex returns ONE card id with a nested `variants[]` array (normal, reverse
-- holofoil, alt art, …), each carrying its own prices + images. To reach parity
-- with Scrydex ("whatever we search in Scrydex comes the same in our app") we
-- expand one Scrydex card into ONE ROW PER PRINTING. That means:
--   * A new `printing` column holds the verbatim Scrydex variant name. The BASE
--     printing keeps the existing row's externalId; non-base printings use the
--     `${baseId}::${name}` composite key (which rides `externalId @unique`).
--   * `scrydexId` can no longer be @unique — many rows legitimately share one
--     Scrydex card id — so its unique constraint is swapped for a plain index.
--
-- `number` has NO uniqueness to drop (Card declared only externalId @unique and
-- scrydexId @unique). `externalId` STAYS @unique — the composite key rides it.
--
-- This change is ADDITIVE + an index swap only: one new nullable column
-- (backfilled to 'normal'), drop a UNIQUE index, create a non-unique index. No
-- data loss, no drops of columns, no type narrowing. Reversal:
--   DROP INDEX IF EXISTS "card_scrydexId_idx";
--   CREATE UNIQUE INDEX IF NOT EXISTS "card_scrydexId_key" ON "card" ("scrydexId");
--   ALTER TABLE "card" DROP COLUMN "printing";
--
-- APPLY (owner/orchestrator only — NEVER auto-run against the Mumbai DB in any
-- build/verify step). See APPLY.md in this directory for the exact
-- `npx -y prisma@6 migrate deploy` command, the Docker-psql fallback, and the
-- verify queries. This file only AUTHORS the migration; there is no live DB in
-- the build sandbox.
--
-- IDEMPOTENT: every statement uses IF (NOT) EXISTS so a repeat `migrate deploy`
-- is safe.

ALTER TABLE "card" ADD COLUMN IF NOT EXISTS "printing" TEXT;

UPDATE "card" SET "printing" = 'normal' WHERE "printing" IS NULL;

DROP INDEX IF EXISTS "card_scrydexId_key";

CREATE INDEX IF NOT EXISTS "card_scrydexId_idx" ON "card" ("scrydexId");
