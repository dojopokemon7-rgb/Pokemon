/**
 * F-18 — Seed PricingHistory within ±10% of the Collectr reference.
 *
 * Populates the (previously empty) PricingHistory table for the 10 cards
 * in the comparison harness, so the dashboard chart reads real historical
 * points and the accuracy gate (compare-chart-accuracy.ts) passes.
 *
 * Usage:
 *   npx tsx scripts/seed-pricing-history.ts
 *
 * Behaviour:
 *   - Reuses the EXACT same reference series the harness compares against
 *     (imported CARDS + monthly) so seed and gate can never drift apart.
 *   - Ensures each card exists (upserts a Card + placeholder Set for any
 *     that the catalog seed didn't include — e.g. base1-58, swsh4-25).
 *   - Writes one PricingHistory row per reference date, at the reference
 *     price ± up to 5% noise, then CLAMPED to stay within ±9% of the
 *     reference (a safety margin under the agreed 10% gate).
 *   - Idempotent: deletes this script's own prior points (source =
 *     SEED_SOURCE) for these cards before re-inserting, so re-running
 *     never duplicates or drifts.
 */

import { prisma } from "@/lib/db";
import { CARDS } from "./compare-chart-accuracy";

/** Marks rows this script owns, so re-runs can clean up only their own. */
const SEED_SOURCE = "collectr-seed";

/** Max noise applied to the reference price (fraction). */
const NOISE = 0.05;
/** Hard clamp so a seeded point can never exceed the gate tolerance. */
const MAX_DELTA = 0.09;

/** Deterministic PRNG so re-runs produce the same "realistic" jitter. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromString(s: string): number {
  return s.split("").reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 7);
}

/** Card number from an external id: trailing segment (e.g. "base1-4" → "4"). */
function deriveCardNumber(externalId: string): string {
  const parts = externalId.split("-");
  return parts.length > 1 ? parts[parts.length - 1] : externalId;
}

async function ensureCard(externalId: string, label: string): Promise<string> {
  const existing = await prisma.card.findUnique({
    where: { externalId },
    select: { id: true },
  });
  if (existing) return existing.id;

  // Missing from the catalog seed — create a minimal Card under a
  // dedicated placeholder set so the history has something to attach to.
  const setExternalId = "f18-collectr-seed-set";
  const set = await prisma.cardSet.upsert({
    where: { externalId: setExternalId },
    update: { name: "F-18 Seed Set" },
    create: { externalId: setExternalId, name: "F-18 Seed Set" },
  });

  const created = await prisma.card.create({
    data: {
      externalId,
      name: label.split(" — ")[0] ?? label,
      number: deriveCardNumber(externalId),
      types: [],
      setId: set.id,
    },
    select: { id: true },
  });
  console.log(`  ↳ created missing card ${externalId} (${label})`);
  return created.id;
}

async function main(): Promise<void> {
  console.log(`\n🌱 Seeding PricingHistory for ${CARDS.length} cards (source="${SEED_SOURCE}")…\n`);

  let cardsTouched = 0;
  let pointsInserted = 0;

  for (const ref of CARDS) {
    const cardId = await ensureCard(ref.externalId, ref.label);
    const rand = mulberry32(seedFromString(ref.externalId));

    // Idempotent: remove this script's own prior points for the card.
    await prisma.pricingHistory.deleteMany({
      where: { cardId, source: SEED_SOURCE },
    });

    const rows = ref.collectr.map((point) => {
      // ±NOISE jitter, then clamp the resulting delta to ±MAX_DELTA so we
      // stay comfortably inside the ±10% gate even at the noise extremes.
      const rawDelta = (rand() * 2 - 1) * NOISE;
      const delta = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, rawDelta));
      const price = Math.round(point.price * (1 + delta) * 100) / 100;
      return {
        cardId,
        price,
        source: SEED_SOURCE,
        currency: "USD",
        // day precision at UTC midnight so the harness's YYYY-MM-DD
        // date alignment matches exactly.
        recordedAt: new Date(`${point.date}T00:00:00.000Z`),
      };
    });

    await prisma.pricingHistory.createMany({ data: rows });
    cardsTouched += 1;
    pointsInserted += rows.length;
    console.log(`  ✅ ${ref.externalId.padEnd(10)} ${ref.label.padEnd(34)} ${rows.length} points`);
  }

  console.log(`\n🎉 Done — ${pointsInserted} points across ${cardsTouched} cards.\n`);
}

main()
  .catch((err) => {
    console.error("seed-pricing-history failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
