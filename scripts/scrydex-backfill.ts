/**
 * Scrydex backfill pilot (FR-7, design §8).
 *
 * Pulls Scrydex pricing for exactly 10 collection-active cards by deferring
 * ENTIRELY to pullAndStoreScrydexPrice — the single writer that owns the
 * freshness gate, the first-pull trend backfill, the variant/condition
 * normalization, and the credit metering. This script does ZERO direct Prisma
 * writes (the old inline createMany + "Near Mint"/"Normal" literals are gone),
 * so it CANNOT drift from the daily sync path: same gate, same normalization,
 * same meter.
 *
 * Purpose: MEASURE the real per-call credit cost before any bulk backfill.
 * Calls are spaced ≥3s apart — rapid repeats to api.scrydex.com trip Cloudflare
 * and HANG (not error). Idempotent: re-runs within SCRYDEX_STALE_MS skip via
 * the freshness gate.
 */
import { prisma } from "../src/lib/db";
import {
  pullAndStoreScrydexPrice,
  type ScrydexPullCard,
} from "../src/lib/services/scrydex-pricing.service";

const MAX_CARDS = 10;
const SLEEP_MS = 3000; // Cloudflare pacing (contracts: space Scrydex calls 3–5s)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`Starting Scrydex backfill pilot for ${MAX_CARDS} cards...`);

  const cards = await prisma.card.findMany({
    where: { userCollections: { some: {} } },
    take: MAX_CARDS,
    select: {
      id: true,
      externalId: true,
      name: true,
      number: true,
      game: true,
      scrydexId: true,
      set: { select: { name: true } },
    },
  });

  if (cards.length === 0) {
    console.log("No active cards found to backfill.");
    return;
  }

  let totalCredits = 0;
  let okCount = 0;
  let skipCount = 0;
  let failCount = 0;

  for (const card of cards) {
    const input: ScrydexPullCard = {
      id: card.id,
      externalId: card.externalId,
      name: card.name,
      number: card.number,
      game: card.game,
      scrydexId: card.scrydexId,
      setName: card.set?.name ?? null,
    };

    try {
      const { pulled, credits } = await pullAndStoreScrydexPrice(input);
      totalCredits += credits;
      if (pulled) {
        okCount++;
        console.log(`  OK   [${card.externalId}] ${card.name} — ${credits} credit(s)`);
      } else {
        // pulled:false is either a freshness-gate skip or a failed match; both
        // return credits:0. The SyncLog row distinguishes them for auditing.
        skipCount++;
        console.log(`  SKIP [${card.externalId}] ${card.name} — gated or no match`);
      }
    } catch (err) {
      failCount++;
      console.error(
        `  FAIL [${card.externalId}] ${card.name}:`,
        err instanceof Error ? err.message : err
      );
    }

    await sleep(SLEEP_MS);
  }

  console.log("\n--- Backfill Summary ---");
  console.log(`Processed:      ${cards.length}`);
  console.log(`Pulled (ok):    ${okCount}`);
  console.log(`Skipped/gated:  ${skipCount}`);
  console.log(`Failed:         ${failCount}`);
  console.log(`TOTAL CREDITS:  ${totalCredits}`);
  console.log(
    `Per-pull credit cost: ${
      okCount > 0 ? (totalCredits / okCount).toFixed(2) : "n/a"
    } (update SCRYDEX_CREDITS_PER_CALL if this differs from 1)`
  );
  console.log("------------------------\n");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
