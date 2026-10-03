/**
 * Read-only Scrydex bulk-refresh credit estimator.
 *
 * Prints the local catalog size and the documented credit cost of a full
 * bulk refresh at three scopes, so the owner can see the exact impact BEFORE
 * approving any live spend (plan §1/§7.5).
 *
 * SAFETY: this makes ZERO Scrydex calls and spends ZERO credits. It only runs a
 * local Postgres COUNT (and an optional stale-count) to size the estimate. It
 * never writes anything. Run with: `npx tsx scripts/estimate-scrydex-bulk.ts`.
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { SCRYDEX_CREDIT_COST } from "../src/lib/services/scrydex-credit-gate";

const STALE_MS = 24 * 60 * 60 * 1000;

async function main() {
  const total = await prisma.card.count();

  // Cards whose newest scrydex history pull is older than 24h (or never) — the
  // set a steady-state refresh would actually touch (the freshness gate skips
  // the rest). Approximate via cards with no recent scrydex SyncLog.
  const freshCutoff = new Date(Date.now() - STALE_MS);
  const freshlyPulled = await prisma.syncLog.findMany({
    where: { job: "scrydex_history", status: "ok", ranAt: { gte: freshCutoff } },
    select: { cardId: true },
    distinct: ["cardId"],
  });
  const freshCount = new Set(freshlyPulled.map((s) => s.cardId).filter(Boolean)).size;
  const staleOrNew = Math.max(0, total - freshCount);

  const perCurrent = SCRYDEX_CREDIT_COST.standard; // 1
  const perPlusHistory = SCRYDEX_CREDIT_COST.standard + SCRYDEX_CREDIT_COST.priceHistory; // 4
  const perPlusSold = perPlusHistory + SCRYDEX_CREDIT_COST.listings; // 5

  const fmt = (n: number) => n.toLocaleString();
  console.log("=== Scrydex bulk-refresh credit estimate (NO live calls) ===\n");
  console.log(`Local catalog size:            ${fmt(total)} cards`);
  console.log(`Fresh (<24h, would be skipped): ${fmt(freshCount)} cards`);
  console.log(`Stale/new (would refresh):      ${fmt(staleOrNew)} cards\n`);

  const scopes = [
    ["Current price only", perCurrent],
    ["Price + RAW history", perPlusHistory],
    ["Price + history + sold", perPlusSold],
  ] as const;

  console.log("FULL backfill (all cards):");
  for (const [label, per] of scopes) {
    console.log(`  ${label.padEnd(26)} ${per} cr/card → ${fmt(total * per)} credits`);
  }
  console.log("\nSTEADY-STATE refresh (stale/new only, freshness-gated):");
  for (const [label, per] of scopes) {
    console.log(`  ${label.padEnd(26)} ${per} cr/card → ${fmt(staleOrNew * per)} credits`);
  }

  console.log(
    "\nNOTE: documented costs (standard 1 / history 3 / listings 1). Confirm the\n" +
      "real per-op burn against /account/v1/usage (delayed ~20–30 min). Do NOT run\n" +
      "a bulk refresh until the owner approves this estimate (Checkpoint D)."
  );
}

main()
  .catch((err) => {
    console.error("estimate failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
