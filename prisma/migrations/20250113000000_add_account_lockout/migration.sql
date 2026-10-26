-- H-2: per-account brute-force lockout (OWASP A07/A04)
-- Adds two columns to the Better Auth `user` table, managed solely by the
-- sign-in hooks in src/lib/auth.ts. Both are additive and safe on existing
-- rows (defaulted / nullable), so no backfill is required.

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedUntil" TIMESTAMP(3);
