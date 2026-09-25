/**
 * One-off cleanup: remove DUPLICATE cards in the catch-all
 * `pokemon-unknown-set` bucket that already have a proper copy in a real set
 * (e.g. "me04-022" is a stale dup of "me4-022" in Chaos Rising).
 *
 * SAFETY: only deletes an Unknown-Set card when a normalized TWIN exists under
 * a real set AND the card is in no user's collection. Orphans (real cards
 * whose set never resolved) are left alone. Dry-run unless `--apply`.
 *
 * Run:  node scripts/cleanup-unknown-set.mjs           (dry run)
 *       node scripts/cleanup-unknown-set.mjs --apply
 */
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const bucket = await prisma.cardSet.findFirst({
  where: { externalId: "pokemon-unknown-set" },
  select: { id: true },
});
if (!bucket) {
  console.log("No pokemon-unknown-set bucket — nothing to do.");
  await prisma.$disconnect();
  process.exit(0);
}

// Pull everything we need in 3 bulk queries instead of per-card round trips.
const [unknownCards, realCards] = await Promise.all([
  prisma.card.findMany({ where: { setId: bucket.id }, select: { id: true, externalId: true, name: true } }),
  prisma.card.findMany({ where: { setId: { not: bucket.id } }, select: { externalId: true } }),
]);
const realIds = new Set(realCards.map((c) => c.externalId));
console.log(`Unknown Set: ${unknownCards.length} cards. Real-set catalog: ${realIds.size} ids.`);

const norm = (ext) => {
  const m = ext.match(/^([a-z]+?)0*(\d*)-0*(\d+)$/i);
  return m ? `${m[1]}${m[2]}-${m[3]}` : ext;
};

// Candidates: Unknown-Set card whose normalized id matches a real-set id.
const candidates = unknownCards.filter((c) => {
  const alt = norm(c.externalId);
  return alt !== c.externalId && realIds.has(alt);
});

// One bulk ownership check for all candidates.
const ownedRows = candidates.length
  ? await prisma.userCollection.findMany({
      where: { cardId: { in: candidates.map((c) => c.id) } },
      select: { cardId: true },
    })
  : [];
const ownedIds = new Set(ownedRows.map((r) => r.cardId));

const toDelete = candidates.filter((c) => !ownedIds.has(c.id));
console.log(`\n${toDelete.length} duplicate(s) with a real-set twin (0 owned skipped ${candidates.length - toDelete.length}):`);
toDelete.forEach((c) => console.log(`  ${c.externalId} "${c.name}"  ->  keep ${norm(c.externalId)}`));

if (!APPLY) {
  console.log("\nDRY RUN — nothing deleted. Re-run with --apply.");
  await prisma.$disconnect();
  process.exit(0);
}

const result = await prisma.card.deleteMany({ where: { id: { in: toDelete.map((c) => c.id) } } });
console.log(`\nDeleted ${result.count} duplicate Unknown-Set cards.`);
await prisma.$disconnect();
