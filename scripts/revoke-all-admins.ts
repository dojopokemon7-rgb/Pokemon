/**
 * OWNER-RUN — strips the retired `isAdmin` flag platform-wide.
 *
 * The admin is now the ENV-defined superuser (ADMIN_EMAIL/ADMIN_PASSWORD) and
 * logs in only at /admin with mandatory OTP. The DB `isAdmin` column is NO
 * LONGER read for authorization anywhere, so any row still carrying
 * isAdmin:true is a stale flag. This script sets isAdmin=false on EVERY such
 * row. It KEEPS all user rows (no deletes) — those accounts remain usable as
 * normal users; only the dead admin flag is cleared.
 *
 * Usage:
 *   npx tsx scripts/revoke-all-admins.ts            # DRY RUN (default): counts only, NO writes
 *   npx tsx scripts/revoke-all-admins.ts --apply    # EXECUTE: flip isAdmin→false
 */
import { prisma } from "../src/lib/db";
import { revokeAllAdmins } from "../src/lib/utils/revoke-admins";

const APPLY = process.argv.slice(2).includes("--apply");

async function main() {
  const result = await revokeAllAdmins(prisma, { apply: APPLY });

  console.log(`\n[revoke-all-admins] ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`  rows with isAdmin=true : ${result.count}  <- WOULD SET isAdmin=false`);
  if (result.sampleEmails.length > 0) {
    console.log(
      `  sample emails          : ${result.sampleEmails.join(", ")}${result.count > result.sampleEmails.length ? ", …" : ""}`
    );
  }

  if (!APPLY) {
    console.log("\nDRY RUN — no rows changed. Re-run with --apply to execute.\n");
    return;
  }
  console.log(`\n[revoke-all-admins] Set isAdmin=false on ${result.updated} row(s). User rows kept.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
