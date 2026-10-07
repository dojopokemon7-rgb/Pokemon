/**
 * E2E fixture seeder for F-19 (Graded Add Flow).
 *
 * The production seed (prisma/seed.ts) pulls real TCG data whose rarities
 * are things like "Rare Holo" — never "PSA <n>" — so no *graded* card is
 * discoverable through /search or /trending in the running app. Those
 * routes filter the catalog by `CardSet.externalId` starting with
 * "pokemon-" / "onepiece-", and only surface catalog rows (not the
 * `user-added-*` sets the collection POST creates).
 *
 * So this script upserts ONE catalog card whose set uses the "pokemon-"
 * prefix (making it searchable) and whose `rarity` encodes graded-ness as
 * "PSA 10" (the seed convention — no dedicated grade column yet). Run with
 * `up` to seed and `down` to remove it, leaving the DB as we found it.
 *
 *   npx tsx e2e/fixtures/seed-graded-card.ts up
 *   npx tsx e2e/fixtures/seed-graded-card.ts down
 */
import { prisma } from "@/lib/db";

export const GRADED_EXTERNAL_ID = "pokemon-e2e-graded-f19";
export const GRADED_NAME = "E2E Graded Charizard";
export const GRADED_RARITY = "PSA 10";
const SET_EXTERNAL_ID = "pokemon-e2e-graded-set";

async function up(): Promise<void> {
  // The `authed` project runs this spec across several parallel workers, each
  // of which runs beforeAll(up)/afterAll(down) for the SAME shared card. A
  // sibling worker's `down()` (which deletes the CardSet) can land between this
  // worker's set-upsert and card-upsert, dangling the card_setId_fkey (P2003).
  // Re-upsert the set + card in ONE transaction and retry once on that race so
  // the fixture self-heals instead of flaking the first attempt.
  async function seedOnce(): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const set = await tx.cardSet.upsert({
        where: { externalId: SET_EXTERNAL_ID },
        update: { name: "E2E Graded Set" },
        create: { externalId: SET_EXTERNAL_ID, name: "E2E Graded Set" },
      });
      await tx.card.upsert({
        where: { externalId: GRADED_EXTERNAL_ID },
        update: { rarity: GRADED_RARITY, marketPrice: 35000, lastPricedAt: new Date(), setId: set.id },
        create: {
          externalId: GRADED_EXTERNAL_ID,
          name: GRADED_NAME,
          number: "4/102",
          rarity: GRADED_RARITY,
          types: ["Fire"],
          imageUrl: "https://example.test/pokemon/e2e-graded.png",
          marketPrice: 35000,
          lastPricedAt: new Date(),
          setId: set.id,
        },
      });
    });
  }

  try {
    await seedOnce();
  } catch (err) {
    // P2003 = FK violated (parallel `down` yanked the set mid-insert). One retry
    // re-creates the set + card atomically. Re-throw anything else.
    if (err instanceof Error && "code" in err && (err as { code?: string }).code === "P2003") {
      await seedOnce();
    } else {
      throw err;
    }
  }
  console.log(`seeded graded card ${GRADED_EXTERNAL_ID}`);
}

async function down(): Promise<void> {
  await prisma.card.deleteMany({ where: { externalId: GRADED_EXTERNAL_ID } });
  await prisma.cardSet.deleteMany({ where: { externalId: SET_EXTERNAL_ID } });
  console.log(`removed graded card ${GRADED_EXTERNAL_ID}`);
}

(process.argv[2] === "down" ? down() : up())
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
