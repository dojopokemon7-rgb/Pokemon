/**
 * Break-glass: clears the durable admin login guard counters (S-2) so a locked
 * admin can log in immediately instead of waiting out the <=15 min window.
 *
 * Deletes ONLY `verification` rows whose id starts with `admin-guard:` (the
 * per-IP/global password, OTP-mint and OTP-guess counters). It never touches
 * Better Auth's own verification rows, users, or sessions, and prints no secrets.
 *
 * Usage (needs tsx + the repo checkout; NOT available inside the production
 * standalone image — see docs/ARCHITECTURE.md for the psql one-liner there):
 *   $env:DATABASE_URL="postgresql://..."   # operator-supplied, never committed
 *   npx tsx scripts/clear-admin-guard.ts          # asks for confirmation
 *   npx tsx scripts/clear-admin-guard.ts --yes    # non-interactive
 *
 * SQL equivalent:  DELETE FROM verification WHERE id LIKE 'admin-guard:%';
 */
import { createInterface } from "node:readline/promises";
import { prisma } from "@/lib/db";

async function confirmed(): Promise<boolean> {
  if (process.argv.includes("--yes")) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question("Delete all admin-guard:* rows from the verification table? [y/N] ");
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  if (!(await confirmed())) {
    console.log("Aborted; nothing deleted.");
    return;
  }
  const { count } = await prisma.verification.deleteMany({
    where: { id: { startsWith: "admin-guard:" } },
  });
  console.log(`Cleared ${count} admin-guard row(s).`);
}

main()
  .catch((err) => {
    console.error("Failed to clear admin guard:", err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
