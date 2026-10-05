/**
 * OWNER-RUN - writes to the configured DATABASE_URL; never run by agents.
 *
 * Moves legacy unassigned (collectionId = null) ACTIVE lots into each user's
 * protected "Main" collection. Reversible via a manifest.
 *
 * Usage:
 *   npx tsx scripts/backfill-main-collection.ts                       # DRY RUN (default): counts only, no writes
 *   npx tsx scripts/backfill-main-collection.ts --user <userId>       # limit scope to one user
 *   npx tsx scripts/backfill-main-collection.ts --apply               # create Main per user + move rows, write manifest
 *   npx tsx scripts/backfill-main-collection.ts --rollback <file>     # set collectionId back to null for manifest rows
 *                                                                     # that are CURRENTLY in that user's Main
 *
 * Safety:
 *  - Rows that would collide with the `uc_variant_coalesced` unique index
 *    (same user+card+foil+condition already active in Main) are REPORTED and
 *    skipped, never merged. Sold rows are skipped (reported). Want-list rows
 *    are not touched (count reported only).
 *  - Every update is `where: { id, userId, collectionId: null }` so a row that
 *    changed since the plan was made is left alone. Re-running is idempotent.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { prisma } from "../src/lib/db";
import { getOrCreateMainCollection } from "../src/lib/services/collection.service";
import { isMainCollectionName } from "../src/lib/utils/main-collection";
import { planMainBackfill, planRollback, type BackfillRow } from "../src/lib/utils/main-backfill";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const valueOf = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const APPLY = flag("--apply");
const ROLLBACK = valueOf("--rollback");
const ONLY_USER = valueOf("--user");

const select = { id: true, userId: true, cardId: true, isFoil: true, condition: true, isSold: true } as const;

async function rollback(file: string) {
  const manifest = JSON.parse(readFileSync(file, "utf8")).moved as { id: string; userId: string }[];
  const scope = ONLY_USER ? manifest.filter((m) => m.userId === ONLY_USER) : manifest;
  const mains = (await prisma.collection.findMany({ select: { id: true, userId: true, name: true } })).filter((c) =>
    isMainCollectionName(c.name)
  );
  const mainIdByUser = new Map(mains.map((m) => [m.userId, m.id]));
  const current = await prisma.userCollection.findMany({
    where: { id: { in: scope.map((m) => m.id) } },
    select: { id: true, userId: true, collectionId: true },
  });
  const currentMain = current.filter((r) => r.collectionId && r.collectionId === mainIdByUser.get(r.userId));
  const toRoll = planRollback(scope, currentMain);
  console.log(`[rollback] manifest=${scope.length} currentlyInMain=${toRoll.length} ${APPLY ? "" : "(dry run: add --apply)"}`);
  if (!APPLY) return;
  let n = 0;
  for (const r of toRoll) {
    const res = await prisma.userCollection.updateMany({
      where: { id: r.id, userId: r.userId, collectionId: mainIdByUser.get(r.userId) },
      data: { collectionId: null },
    });
    n += res.count;
  }
  console.log(`[rollback] reverted ${n} rows`);
}

async function backfill() {
  const userFilter = ONLY_USER ? { userId: ONLY_USER } : {};
  const unassigned = (await prisma.userCollection.findMany({
    where: { collectionId: null, ...userFilter },
    select,
  })) as BackfillRow[];
  const mains = (await prisma.collection.findMany({ where: userFilter, select: { id: true, userId: true, name: true } })).filter(
    (c) => isMainCollectionName(c.name)
  );
  const mainIds = mains.map((m) => m.id);
  const existingMain = (await prisma.userCollection.findMany({
    where: { collectionId: { in: mainIds } },
    select,
  })) as BackfillRow[];
  const wantNull = await prisma.wantListItem.count({ where: { collectionId: null, ...userFilter } });

  const plan = planMainBackfill(unassigned, existingMain);
  console.log(
    `[backfill] ${APPLY ? "APPLY" : "DRY RUN"} rows: movable=${plan.movable.length} conflicts=${plan.conflicts.length} ` +
      `skippedSold=${plan.skippedSold.length} users=${Object.keys(plan.perUser).length} wantListNullUntouched=${wantNull}`
  );
  console.table(plan.perUser);
  for (const c of plan.conflicts) console.log(`[conflict] ${c.userId} row ${c.id} card ${c.cardId} (left unassigned)`);
  if (!APPLY) return console.log("[backfill] dry run only. Re-run with --apply to write.");

  const mainByUser = new Map(mains.map((m) => [m.userId, m.id]));
  const moved: { id: string; userId: string }[] = [];
  for (const r of plan.movable) {
    let mainId = mainByUser.get(r.userId);
    if (!mainId) {
      mainId = (await getOrCreateMainCollection(r.userId)).id;
      mainByUser.set(r.userId, mainId);
    }
    const res = await prisma.userCollection.updateMany({
      where: { id: r.id, userId: r.userId, collectionId: null },
      data: { collectionId: mainId },
    });
    if (res.count === 1) moved.push({ id: r.id, userId: r.userId });
  }
  const manifestFile = `backfill-main-manifest-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(manifestFile, JSON.stringify({ createdAt: new Date().toISOString(), moved }, null, 2));
  console.log(`[backfill] moved ${moved.length} rows. Manifest: ${manifestFile} (keep for --rollback)`);
}

(ROLLBACK ? rollback(ROLLBACK) : backfill())
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
