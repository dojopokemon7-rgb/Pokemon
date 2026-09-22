/**
 * F-18 — Snapshot current Pokémon TCG market prices into PricingHistory.
 *
 * The Pokémon TCG API only exposes the CURRENT market price (no history),
 * so we build the historical series by recording today's real price on a
 * schedule. Run this daily (cron) to accumulate genuine history that the
 * chart (/api/cards/[id]/history) then reads.
 *
 * Usage:
 *   npx tsx scripts/snapshot-pokemon-prices.ts
 *
 * Behaviour:
 *   - Fetches the live TCGplayer "market" price for each Pokémon card in the
 *     tracked set via the real Pokémon TCG API (pokemon-price.service).
 *   - Appends ONE PricingHistory row per card (source="pokemon-tcg-api"),
 *     stamped at UTC midnight today so the chart aligns by day.
 *   - Idempotent per day: replaces any existing pokemon-tcg-api row for the
 *     same card + day, so re-running the same day never duplicates a point.
 *   - Skips (with a log) any card the API has no price for — never writes a
 *     fabricated number.
 *
 * NOTE: this is Pokémon-only (One Piece prices come from apitcg via the
 * card sync). The One Piece / graded chart data remains on its existing
 * pipeline; this script adds the real Pokémon current-price snapshots.
 */

import { prisma } from "@/lib/db";
import { fetchPokemonMarketPrice } from "@/lib/services/pokemon-price.service";
import { CARDS } from "./compare-chart-accuracy";

/** Marks rows this script owns (real API snapshots). */
const SNAPSHOT_SOURCE = "pokemon-tcg-api";

/** Only Pokémon ids (the API is Pokémon-only). The tracked list reuses the
 *  chart-accuracy card set; One Piece ids (OP…) are skipped here. */
const isPokemonId = (externalId: string): boolean => /^(base|swsh|sv|sm|xy|bw|hgss|dp|ex|col|pl|np|si)/i.test(externalId) || !externalId.startsWith("OP");

/** UTC midnight for today, so daily points align by YYYY-MM-DD. */
function utcMidnightToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function main(): Promise<void> {
  const day = utcMidnightToday();
  const dayLabel = day.toISOString().slice(0, 10);
  const targets = CARDS.filter((c) => isPokemonId(c.externalId));

  console.log(
    `\n📈 Snapshotting Pokémon market prices for ${targets.length} cards @ ${dayLabel} ` +
      `(source="${SNAPSHOT_SOURCE}")…\n`
  );

  let written = 0;
  let skipped = 0;

  for (const ref of targets) {
    const card = await prisma.card.findUnique({
      where: { externalId: ref.externalId },
      select: { id: true },
    });
    if (!card) {
      console.log(`  ⚠️  ${ref.externalId.padEnd(10)} not in catalog — skipped`);
      skipped += 1;
      continue;
    }

    const price = await fetchPokemonMarketPrice(ref.externalId);
    if (!price) {
      console.log(`  ⚠️  ${ref.externalId.padEnd(10)} no live price — skipped (no fabrication)`);
      skipped += 1;
      continue;
    }

    // Idempotent per day: clear any snapshot this script already wrote for
    // this card today, then insert the fresh one.
    const nextDay = new Date(day.getTime() + 24 * 60 * 60 * 1000);
    await prisma.pricingHistory.deleteMany({
      where: {
        cardId: card.id,
        source: SNAPSHOT_SOURCE,
        recordedAt: { gte: day, lt: nextDay },
      },
    });
    await prisma.pricingHistory.create({
      data: {
        cardId: card.id,
        price: price.value,
        source: SNAPSHOT_SOURCE,
        currency: price.currency,
        recordedAt: day,
      },
    });
    // Keep Card.marketPrice fresh too, so tiles show the same live number.
    await prisma.card.update({
      where: { id: card.id },
      data: { marketPrice: price.value, lastPricedAt: new Date() },
    });

    console.log(`  ✅ ${ref.externalId.padEnd(10)} $${price.value}`);
    written += 1;
  }

  console.log(`\n🎉 Done — ${written} snapshot(s) written, ${skipped} skipped.\n`);
}

main()
  .catch((err) => {
    console.error("snapshot-pokemon-prices failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
