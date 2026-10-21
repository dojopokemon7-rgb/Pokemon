import { describe, it, expect } from "vitest";
import { displayPrice, type GradedPriceRow } from "@/lib/utils/graded-price";
import { statsFromLots } from "@/lib/utils/portfolio-accounting";

/**
 * Cross-surface graded-value parity regression (the bug confirmed on staging).
 *
 * ONE lot: Charizard, Base (base1-4), "PSA 9", qty 1 — valued THREE ways before
 * the fix: summary $6,163.18 (correct), Most-Valuable $359.95 (raw — Bug A),
 * chart-hover $4,200.00 (stale history variant — Bug B). This file pins the
 * NON-chart half of the invariant: the SUMMARY value, the Most-Valuable per-lot
 * value, and displayPrice must ALL resolve to the SAME authoritative graded
 * price. The chart's latest-point half is pinned in collection-series.test.ts.
 *
 * INVARIANT: for any owned lot,
 *   displayPrice(lot) === statsFromLots([lot]).marketValue
 *     === the Most-Valuable per-lot value === (chart latest, pinned elsewhere).
 */
describe("graded-value parity — base1-4 PSA 9 lot (summary == Most-Valuable == displayPrice)", () => {
  // The four REAL PSA 9 current_price variants for base1-4. The shared selector
  // (pickRealGradedPrice → pickGradedVariant) picks unlimitedHolofoil ($6,163.18)
  // as the default among these by variant priority — the authoritative value.
  const gradedPrices: GradedPriceRow[] = [
    { type: "graded", company: "PSA", grade: "9", variant: "firstEditionShadowlessHolofoil", condition: null, priceMarket: 82660.12 },
    { type: "graded", company: "PSA", grade: "9", variant: "unlimitedShadowlessHolofoil", condition: null, priceMarket: 11750.5 },
    { type: "graded", company: "PSA", grade: "9", variant: "unlimitedHolofoil", condition: null, priceMarket: 6163.18 },
    { type: "graded", company: "PSA", grade: "9", variant: "metal", condition: null, priceMarket: 540.77 },
  ];
  const RAW = 359.95; // the raw card.marketPrice Bug A wrongly surfaced
  const AUTHORITATIVE = 6163.18;

  const lot = {
    isSold: false as const,
    soldPrice: null,
    condition: "PSA 9",
    quantity: 1,
    isFoil: false,
    purchasePrice: null,
    card: { marketPrice: RAW, gradedPrices },
  };

  it("displayPrice resolves the PSA 9 graded value, not the raw price", () => {
    expect(displayPrice(lot)).toBe(AUTHORITATIVE);
    expect(displayPrice(lot)).not.toBe(RAW);
  });

  it("statsFromLots marketValue equals the same graded value", () => {
    const stats = statsFromLots([
      { quantity: 1, purchasePrice: null, marketPrice: RAW, isSold: false, condition: "PSA 9", gradedPrices },
    ]);
    expect(stats.marketValue).toBe(AUTHORITATIVE);
  });

  it("Most-Valuable per-lot value (displayPrice × qty) equals the graded value, NOT the raw", () => {
    // This mirrors the DashboardClient `mostValuable` computation (Bug A fix):
    // the per-lot value is `(displayPrice(item) ?? 0) * item.quantity`.
    const mostValuableValue = (displayPrice(lot) ?? 0) * lot.quantity;
    expect(mostValuableValue).toBe(AUTHORITATIVE);
    expect(mostValuableValue).not.toBe(RAW); // the regression that caught Bug A
  });

  it("all three non-chart surfaces agree on the single authoritative value", () => {
    const display = displayPrice(lot) ?? 0;
    const summary = statsFromLots([
      { quantity: 1, purchasePrice: null, marketPrice: RAW, isSold: false, condition: "PSA 9", gradedPrices },
    ]).marketValue;
    const mostValuable = (displayPrice(lot) ?? 0) * lot.quantity;
    expect(display).toBe(summary);
    expect(summary).toBe(mostValuable);
    expect(display).toBe(AUTHORITATIVE);
  });
});
