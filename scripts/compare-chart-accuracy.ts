/**
 * F-18 — Chart Accuracy vs Collectr: divergence harness.
 *
 * Measures how far OUR price-history data (PricingHistory in Supabase)
 * diverges from a fixed "Collectr" reference series, for 10 known cards.
 *
 * Usage:
 *   npx tsx scripts/compare-chart-accuracy.ts
 *
 * This is a READ-ONLY diagnostic — it never writes to the DB. It prints a
 * per-card divergence report and a portfolio-wide summary, then exits.
 *
 * How the comparison works, per card:
 *   - Align by DATE (YYYY-MM-DD). For every Collectr reference point:
 *       • if we have a point on the same date → % difference vs reference
 *       • if we don't → flagged MISSING
 *   - Any point WE have on a date Collectr doesn't → flagged EXTRA.
 *   - Per-card rollup: matched count, missing count, extra count, and the
 *     mean / max absolute % difference across matched dates.
 *
 * NOTE: the Collectr series here is MOCKED (we have no Collectr feed /
 * license). The 10 external IDs are real seeded catalog ids so the DB-side
 * query is genuine — the point of this step is to expose the gap, not to
 * fix it.
 */

import { prisma } from "@/lib/db";
import { pathToFileURL } from "node:url";

/**
 * Agreed accuracy tolerance vs the Collectr reference: a matched data point
 * may differ by at most this many percent. Beyond it, the harness FAILS
 * (non-zero exit) so it can act as a blocking CI gate (test:chart-accuracy).
 */
const TOLERANCE_PCT = 10;

// ── Types ───────────────────────────────────────────────────────────
export interface PricePoint {
  /** ISO date, day precision: "YYYY-MM-DD". */
  date: string;
  price: number;
}

export interface CardRef {
  externalId: string;
  label: string;
  /** Mocked Collectr reference history (monthly points, oldest → newest). */
  collectr: PricePoint[];
}

interface DateComparison {
  date: string;
  refPrice: number;
  ourPrice: number | null;
  /** Signed % difference of ours vs reference; null when MISSING. */
  pctDiff: number | null;
  status: "MATCH" | "MISSING";
}

interface CardReport {
  externalId: string;
  label: string;
  foundInDb: boolean;
  comparisons: DateComparison[];
  extraDates: string[]; // dates we have that Collectr doesn't
  matched: number;
  missing: number;
  extra: number;
  meanAbsPct: number | null;
  maxAbsPct: number | null;
}

// ── Mocked Collectr reference data (6 monthly points per card) ──────
// Prices are representative round numbers for a stable divergence signal;
// the harness cares about date alignment + % delta, not absolute realism.
export function monthly(prices: number[]): PricePoint[] {
  // Anchors the series to the 1st of the last N months, oldest → newest.
  const now = new Date();
  const n = prices.length;
  return prices.map((price, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1 - i), 1));
    return { date: d.toISOString().slice(0, 10), price };
  });
}

export const CARDS: CardRef[] = [
  { externalId: "base1-4",   label: "Charizard — Base Set",            collectr: monthly([320, 335, 360, 355, 380, 410]) },
  { externalId: "base1-2",   label: "Blastoise — Base Set",            collectr: monthly([140, 145, 150, 148, 160, 172]) },
  { externalId: "base1-15",  label: "Venusaur — Base Set",             collectr: monthly([90, 94, 99, 97, 105, 112]) },
  { externalId: "base1-58",  label: "Pikachu — Base Set",              collectr: monthly([18, 19, 20, 21, 22, 24]) },
  { externalId: "swsh4-25",  label: "Pikachu VMAX — Vivid Voltage",    collectr: monthly([55, 58, 62, 60, 66, 71]) },
  { externalId: "OP01-001",  label: "Monkey D. Luffy — Romance Dawn",  collectr: monthly([40, 44, 47, 46, 52, 58]) },
  { externalId: "OP01-025",  label: "Roronoa Zoro — Romance Dawn",     collectr: monthly([30, 31, 34, 33, 37, 41]) },
  { externalId: "OP02-013",  label: "Trafalgar Law — Paramount War",   collectr: monthly([25, 27, 29, 28, 32, 35]) },
  { externalId: "OP01-016",  label: "Shanks — Romance Dawn",           collectr: monthly([48, 50, 55, 53, 60, 66]) },
  { externalId: "OP03-108",  label: "Portgas D. Ace — Pillars",        collectr: monthly([70, 74, 80, 78, 88, 96]) },
];

// ── Our DB history ──────────────────────────────────────────────────
/** Reads our PricingHistory for one card, keyed by external id. */
async function getOurHistory(externalId: string): Promise<PricePoint[] | null> {
  const card = await prisma.card.findUnique({
    where: { externalId },
    select: { id: true },
  });
  if (!card) return null; // card not in our catalog at all

  const rows = await prisma.pricingHistory.findMany({
    where: { cardId: card.id },
    orderBy: { recordedAt: "asc" },
    select: { price: true, recordedAt: true },
  });

  return rows.map((r) => ({
    date: r.recordedAt.toISOString().slice(0, 10),
    price: r.price,
  }));
}

// ── Comparison ──────────────────────────────────────────────────────
function compareCard(ref: CardRef, ours: PricePoint[] | null): CardReport {
  const foundInDb = ours !== null;
  const ourByDate = new Map((ours ?? []).map((p) => [p.date, p.price]));
  const refDates = new Set(ref.collectr.map((p) => p.date));

  const comparisons: DateComparison[] = ref.collectr.map((refPoint) => {
    const ourPrice = ourByDate.get(refPoint.date);
    if (ourPrice == null) {
      return { date: refPoint.date, refPrice: refPoint.price, ourPrice: null, pctDiff: null, status: "MISSING" };
    }
    const pctDiff = ((ourPrice - refPoint.price) / refPoint.price) * 100;
    return { date: refPoint.date, refPrice: refPoint.price, ourPrice, pctDiff, status: "MATCH" };
  });

  const extraDates = (ours ?? []).map((p) => p.date).filter((d) => !refDates.has(d));

  const matchedDiffs = comparisons
    .filter((c) => c.status === "MATCH" && c.pctDiff != null)
    .map((c) => Math.abs(c.pctDiff as number));
  const matched = matchedDiffs.length;
  const missing = comparisons.filter((c) => c.status === "MISSING").length;

  return {
    externalId: ref.externalId,
    label: ref.label,
    foundInDb,
    comparisons,
    extraDates,
    matched,
    missing,
    extra: extraDates.length,
    meanAbsPct: matched > 0 ? matchedDiffs.reduce((a, b) => a + b, 0) / matched : null,
    maxAbsPct: matched > 0 ? Math.max(...matchedDiffs) : null,
  };
}

// ── Reporting ───────────────────────────────────────────────────────
const fmtUSD = (n: number | null) =>
  n == null ? "     —  " : n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const fmtPct = (n: number | null) =>
  n == null ? "   —   " : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

function printCardReport(r: CardReport): void {
  const line = "─".repeat(72);
  console.log(line);
  console.log(`${r.label}   [${r.externalId}]`);
  if (!r.foundInDb) {
    console.log("  ⛔ NOT IN OUR CATALOG — no Card row for this external id.");
  } else if (r.matched === 0 && r.extra === 0) {
    console.log("  ⚠ NO PRICE HISTORY IN OUR DB — every reference point is MISSING.");
  }
  console.log("");
  console.log("  DATE          COLLECTR      OURS         Δ vs COLLECTR   STATUS");
  for (const c of r.comparisons) {
    console.log(
      `  ${c.date}   ${fmtUSD(c.refPrice).padStart(10)}   ${fmtUSD(c.ourPrice).padStart(10)}   ${fmtPct(c.pctDiff).padStart(9)}      ${c.status}`
    );
  }
  if (r.extraDates.length > 0) {
    console.log(`  EXTRA points we have that Collectr doesn't: ${r.extraDates.join(", ")}`);
  }
  console.log("");
  console.log(
    `  Rollup: matched ${r.matched}/${r.comparisons.length} · missing ${r.missing} · extra ${r.extra}` +
      ` · mean |Δ| ${r.meanAbsPct == null ? "n/a" : r.meanAbsPct.toFixed(1) + "%"}` +
      ` · max |Δ| ${r.maxAbsPct == null ? "n/a" : r.maxAbsPct.toFixed(1) + "%"}`
  );
}

async function main(): Promise<void> {
  console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  F-18 — CHART ACCURACY vs COLLECTR — DIVERGENCE REPORT                  ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");
  console.log(`Reference: MOCKED Collectr series · Cards: ${CARDS.length} · Source: our PricingHistory (Supabase)`);

  const reports: CardReport[] = [];
  for (const ref of CARDS) {
    const ours = await getOurHistory(ref.externalId);
    const report = compareCard(ref, ours);
    reports.push(report);
    printCardReport(report);
  }

  // ── Portfolio-wide summary ────────────────────────────────────────
  const totalRefPoints = reports.reduce((s, r) => s + r.comparisons.length, 0);
  const totalMatched = reports.reduce((s, r) => s + r.matched, 0);
  const totalMissing = reports.reduce((s, r) => s + r.missing, 0);
  const totalExtra = reports.reduce((s, r) => s + r.extra, 0);
  const notInDb = reports.filter((r) => !r.foundInDb).length;
  const noHistory = reports.filter((r) => r.foundInDb && r.matched === 0 && r.extra === 0).length;
  const coverage = totalRefPoints > 0 ? (totalMatched / totalRefPoints) * 100 : 0;

  const allDiffs = reports.flatMap((r) =>
    r.comparisons.filter((c) => c.pctDiff != null).map((c) => Math.abs(c.pctDiff as number))
  );
  const overallMeanAbs = allDiffs.length > 0 ? allDiffs.reduce((a, b) => a + b, 0) / allDiffs.length : null;
  const overallMaxAbs = allDiffs.length > 0 ? Math.max(...allDiffs) : null;

  // ── Gate: enforce the agreed 10% tolerance ────────────────────────
  // FAIL conditions (any one trips the gate):
  //   1. a matched point is off by more than TOLERANCE_PCT, or
  //   2. any reference point is MISSING (a gap is a divergence too), or
  //   3. a card isn't in our catalog at all.
  // Each is collected so the report lists exactly what to fix.
  const failures: string[] = [];
  for (const r of reports) {
    if (!r.foundInDb) {
      failures.push(`${r.externalId} — not in our catalog`);
      continue;
    }
    for (const c of r.comparisons) {
      if (c.status === "MISSING") {
        failures.push(`${r.externalId} @ ${c.date} — missing data point`);
      } else if (c.pctDiff != null && Math.abs(c.pctDiff) > TOLERANCE_PCT) {
        failures.push(
          `${r.externalId} @ ${c.date} — Δ ${c.pctDiff.toFixed(1)}% exceeds ±${TOLERANCE_PCT}%`
        );
      }
    }
  }
  const passed = failures.length === 0;

  console.log("═".repeat(72));
  console.log("SUMMARY");
  console.log("═".repeat(72));
  console.log(`  Tolerance                : ±${TOLERANCE_PCT}%`);
  console.log(`  Cards compared           : ${reports.length}`);
  console.log(`  Cards not in our catalog : ${notInDb}`);
  console.log(`  Cards with NO history    : ${noHistory}`);
  console.log(`  Reference data points    : ${totalRefPoints}`);
  console.log(`  Matched (same date)      : ${totalMatched}`);
  console.log(`  Missing (no match)       : ${totalMissing}`);
  console.log(`  Extra (only ours)        : ${totalExtra}`);
  console.log(`  Date coverage            : ${coverage.toFixed(1)}%  (matched / reference points)`);
  console.log(`  Mean |Δ| over matched    : ${overallMeanAbs == null ? "n/a — nothing matched" : overallMeanAbs.toFixed(1) + "%"}`);
  console.log(`  Max |Δ| over matched     : ${overallMaxAbs == null ? "n/a — nothing matched" : overallMaxAbs.toFixed(1) + "%"}`);
  console.log("═".repeat(72));
  if (passed) {
    console.log(`  ✅ PASS — all ${totalRefPoints} points present and within ±${TOLERANCE_PCT}% of Collectr.`);
  } else {
    console.log(`  ❌ FAIL — ${failures.length} issue(s) exceed the ±${TOLERANCE_PCT}% tolerance:`);
    for (const f of failures.slice(0, 20)) console.log(`     • ${f}`);
    if (failures.length > 20) console.log(`     …and ${failures.length - 20} more.`);
  }
  console.log("═".repeat(72));
  console.log("");

  // Non-zero exit on failure so this can gate CI (test:chart-accuracy).
  if (!passed) process.exitCode = 1;
}

// Only auto-run when invoked directly (`tsx scripts/compare-chart-accuracy.ts`),
// not when imported (e.g. by the seed script reusing CARDS/monthly).
const invokedDirectly =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .catch((err) => {
      console.error("compare-chart-accuracy failed:", err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
