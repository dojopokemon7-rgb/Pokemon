/**
 * E2E seam — marks the dedicated e2e user's email verified in the DB.
 *
 * Run via: npx tsx e2e/fixtures/verify-e2e-user.ts
 *
 * With requireEmailVerification:true (Phase A), the setup flow's sign-in now
 * 403s (EMAIL_NOT_VERIFIED) because the sign-up never verifies the address.
 * The e2e webServer is a standalone PRODUCTION build (NODE_ENV=production), so
 * the sender's dev-log branch does NOT fire and there is no console OTP to
 * grep. Instead we mark the dedicated TEST user verified out-of-band — the same
 * provisioning the setup already does — without weakening production security
 * (the plugin + the flag + every endpoint still run exactly as in prod).
 *
 * Reuses seed-graded-card.ts's proven `@/lib/db` alias resolution under tsx.
 */
import { prisma } from "@/lib/db";

const E2E_EMAIL = "e2e-scanner@example.com"; // MUST match e2e/auth.setup.ts

async function main() {
  await prisma.user.updateMany({
    where: { email: E2E_EMAIL },
    data: { emailVerified: true },
  });
  console.log(`verified e2e user ${E2E_EMAIL}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
