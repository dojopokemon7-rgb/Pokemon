import { prisma } from "../src/lib/db";
import { fetchPriceHistory } from "../src/lib/services/scrydex.service";
import { Game } from "@prisma/client";

// Budget for the first test run
const MAX_CARDS = 10;
// We'll test with popular Pokémon cards for this pilot.
const DEFAULT_GAME = Game.POKEMON;

async function main() {
  console.log(`Starting Scrydex backfill pilot for ${MAX_CARDS} cards...`);

  // Grab 10 active cards (in collections)
  const cards = await prisma.card.findMany({
    where: {
      userCollections: { some: {} }
    },
    take: MAX_CARDS,
    select: { id: true, externalId: true, name: true, game: true }
  });

  if (cards.length === 0) {
    console.log("No active cards found to backfill.");
    return;
  }

  let successCount = 0;
  let creditUsageEstimate = 0;

  for (const card of cards) {
    console.log(`Fetching history for [${card.externalId}] ${card.name}...`);
    try {
      // Game mapping: in our schema it's "pokemon" or "onepiece". 
      // The Scrydex service takes the Game enum.
      const gameEnum = card.game;
      
      const points = await fetchPriceHistory(card.externalId, gameEnum);
      
      if (points.length === 0) {
        console.log(`  -> No history found.`);
        continue;
      }
      
      console.log(`  -> Fetched ${points.length} points.`);
      
      // Each history request costs 1 credit.
      creditUsageEstimate += 1;

      // Upsert into PricingHistory
      // Batch insert is faster but createMany doesn't let us ignore duplicates on recordedAt if there isn't a unique constraint covering it alone.
      // We added a unique constraint on (cardId, recordedAt, source, condition, variant) in the previous session.
      
      const insertData = points.map(p => ({
        cardId: card.id,
        recordedAt: new Date(p.date),
        priceMarket: p.marketPrice,
        priceLow: p.lowPrice,
        currency: "USD",
        source: "scrydex",
        condition: "Near Mint", // Assuming default condition for Scrydex charts
        variant: "Normal"
      }));

      // createMany with skipDuplicates: true requires PostgreSQL, which Supabase is.
      await prisma.pricingHistory.createMany({
        data: insertData,
        skipDuplicates: true
      });
      
      successCount++;
    } catch (err) {
      console.error(`  -> Failed:`, err instanceof Error ? err.message : err);
    }

    // Sleep to avoid rate limits
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log("\n--- Backfill Summary ---");
  console.log(`Processed: ${cards.length}`);
  console.log(`Success: ${successCount}`);
  console.log(`Estimated Credits Used: ${creditUsageEstimate}`);
  console.log("------------------------\n");
}

main().catch(console.error).finally(() => prisma.$disconnect());
