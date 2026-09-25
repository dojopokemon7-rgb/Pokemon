/**
 * Deduplicate user_collection rows
 * Merges duplicate entries of the same card (for the same user, isFoil, and condition)
 * into a single row with the combined quantity.
 */
import { prisma } from "../src/lib/db";

async function main() {
  console.log("Starting collection deduplication...");
  const items = await prisma.userCollection.findMany({
    orderBy: { addedAt: "asc" },
  });

  // Group by userId + cardId + isFoil + (condition ?? "") + (collectionId ?? "") + (isSold ?? false)
  const groups = new Map<string, typeof items>();

  const GRADED_RE = /\b(psa|bgs|cgc|sgc|beckett)\b/i;
  const isGraded = (c: string | null | undefined) => !!c && GRADED_RE.test(c);

  for (const item of items) {
    const condKey = isGraded(item.condition) ? (item.condition ?? "").trim().toUpperCase() : "RAW";
    const key = `${item.userId}::${item.cardId}::${item.isFoil}::${condKey}::${item.collectionId ?? ""}::${item.isSold ?? false}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  let mergedCount = 0;
  for (const [key, list] of groups.entries()) {
    if (list.length <= 1) continue;

    const [keeper, ...duplicates] = list;
    const totalQty = list.reduce((sum, i) => sum + i.quantity, 0);

    console.log(`Merging ${duplicates.length} duplicate(s) for key ${key}. Total qty: ${totalQty}`);

    // Update keeper with combined quantity
    await prisma.userCollection.update({
      where: { id: keeper.id },
      data: { quantity: totalQty },
    });

    // Delete duplicates
    for (const dup of duplicates) {
      await prisma.userCollection.delete({
        where: { id: dup.id },
      });
      mergedCount++;
    }
  }

  console.log(`Deduplication complete. Merged and removed ${mergedCount} duplicate rows.`);
}

main()
  .catch((e) => {
    console.error("Deduplication error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
