/**
 * E2E seam — reads the pending email-verification OTP for a given email.
 *
 * Run via: npx tsx e2e/fixtures/read-otp.ts <email>
 * Prints the 6-digit code to stdout for the spec to capture.
 *
 * The emailOTP plugin stores the issued code in the `Verification` table with
 * `identifier` encoding the email (prefixed by the plugin) and `value` as
 * `${otp}:0` (the trailing counter is the attempt count). We recover the
 * plaintext code ONLY because `storeOTP` stays at its DEFAULT "plain" (auth.ts
 * does not set it). If a future hardening pass sets `storeOTP:"hashed"` /
 * `"encrypted"`, this fixture would read an unusable value — the supported
 * reader in that case is the plugin's `GET /email-otp/get-verification-otp`
 * endpoint (which refuses when the code is not stored plain).
 *
 * Reuses seed-graded-card.ts's proven `@/lib/db` alias resolution under tsx.
 */
import { prisma } from "@/lib/db";

async function main() {
  const email = process.argv[2];
  if (!email) {
    throw new Error("usage: npx tsx e2e/fixtures/read-otp.ts <email>");
  }

  // The plugin stores verification rows whose identifier contains the email;
  // pick the most recently created pending row for this address.
  const row = await prisma.verification.findFirst({
    where: { identifier: { contains: email } },
    orderBy: { createdAt: "desc" },
  });
  if (!row) {
    throw new Error(`no pending Verification row found for ${email}`);
  }

  // Stored value is `${otp}:0` under the default "plain" storeOTP.
  const otp = row.value.split(":")[0];
  if (!/^\d{6}$/.test(otp)) {
    throw new Error(`unexpected OTP value shape for ${email}: "${row.value}"`);
  }
  // Print ONLY the code so the spec can read it straight off stdout.
  process.stdout.write(otp);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
