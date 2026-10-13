/**
 * OWNER-RUN — destructive; never run by agents.
 *
 * One-time production-launch data wipe: deletes every NON-admin user and all
 * their owned data, keeping every admin (and the admins' data) intact. Intended
 * to be run ONCE at full production launch to clear pre-launch test accounts.
 *
 * Usage:
 *   npx tsx scripts/flush-nonadmin-users.ts            # DRY RUN (default): counts + sample, NO writes
 *   npx tsx scripts/flush-nonadmin-users.ts --apply    # EXECUTE the delete (IRREVERSIBLE)
 *
 * What it DELETES (where isAdmin = false):
 *   - the User rows themselves, which CASCADE-delete their sessions, accounts,
 *     named collections, user_collection lots, and want_list items
 *     (all `onDelete: Cascade` in schema.prisma);
 *   - their ScanFeedback rows — deleted EXPLICITLY because `ScanFeedback.userId`
 *     is a bare nullable column with NO relation/cascade, so it would otherwise
 *     be orphaned. Anonymous (userId:null) scan rows are left untouched.
 *
 * What it KEEPS:
 *   - every isAdmin=true user and all their data;
 *   - SupportTicket rows (userId is `onDelete: SetNull` → the ticket is kept,
 *     its user nulled);
 *   - Verification tokens (no user FK — keyed by email; leftovers simply expire).
 *
 * Safety: the ONLY selector is `where: { isAdmin: false }`. The script counts
 * admins first and REFUSES to `--apply` (non-zero exit) if zero admins would
 * remain (canFlushNonAdmins) — so a misconfigured DB can't nuke everyone.
 */
import { prisma } from "../src/lib/db";
import { canFlushNonAdmins } from "../src/lib/utils/flush-guard";

const APPLY = process.argv.slice(2).includes("--apply");

async function main() {
  const [adminCount, nonAdmins] = await Promise.all([
    prisma.user.count({ where: { isAdmin: true } }),
    prisma.user.findMany({ where: { isAdmin: false }, select: { id: true, email: true } }),
  ]);
  const ids = nonAdmins.map((u) => u.id);

  // Per-table WOULD-delete counts (cascaded tables counted directly for the
  // dry-run report; the actual delete relies on the FK cascade).
  const [sessions, accounts, collections, userCollections, wantItems, scanFeedback] =
    await Promise.all([
      prisma.session.count({ where: { userId: { in: ids } } }),
      prisma.account.count({ where: { userId: { in: ids } } }),
      prisma.collection.count({ where: { userId: { in: ids } } }),
      prisma.userCollection.count({ where: { userId: { in: ids } } }),
      prisma.wantListItem.count({ where: { userId: { in: ids } } }),
      prisma.scanFeedback.count({ where: { userId: { in: ids } } }),
    ]);

  console.log(`\n[flush-nonadmin-users] ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`  admins kept        : ${adminCount}`);
  console.log(`  non-admin users    : ${ids.length}  <- WOULD DELETE`);
  console.log(`  sessions           : ${sessions}  (cascade)`);
  console.log(`  accounts           : ${accounts}  (cascade)`);
  console.log(`  named collections  : ${collections}  (cascade)`);
  console.log(`  user_collection    : ${userCollections}  (cascade)`);
  console.log(`  want_list items    : ${wantItems}  (cascade)`);
  console.log(`  scan_feedback      : ${scanFeedback}  (explicit delete)`);
  const sample = nonAdmins.slice(0, 5).map((u) => u.email);
  console.log(`  sample emails      : ${sample.join(", ")}${nonAdmins.length > 5 ? ", …" : ""}`);

  const guard = canFlushNonAdmins({ adminCount, nonAdminCount: ids.length });
  if (!guard.allowed) {
    console.error(`\n[flush-nonadmin-users] ABORT — ${guard.reason}`);
    process.exitCode = 1;
    return;
  }

  if (!APPLY) {
    console.log("\nDRY RUN — re-run with --apply to execute.\n");
    return;
  }

  if (ids.length === 0) {
    console.log("\nNothing to delete — no non-admin users found.\n");
    return;
  }

  // All-or-nothing: explicit ScanFeedback delete FIRST (no cascade), then the
  // User delete which cascades the rest.
  await prisma.$transaction([
    prisma.scanFeedback.deleteMany({ where: { userId: { in: ids } } }),
    prisma.user.deleteMany({ where: { id: { in: ids } } }),
  ]);
  console.log(`\n[flush-nonadmin-users] DELETED ${ids.length} non-admin users (+ cascaded data).\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
