import { describe, it, expect } from "vitest";
import { activeCardCounts } from "@/lib/utils/active-card-counts";

/**
 * QA #4 — the You page "Cards" / "Graded" stats must count ACTIVE owned lots
 * only. GET /collection returns sold lots too; summing over them inflated the
 * count (a sold Bisharp read as if still owned → "3" instead of "1").
 */
describe("activeCardCounts", () => {
  it("one active lot (qty 1) + one sold lot yields totalCards = 1 (active only)", () => {
    const { totalCards } = activeCardCounts([
      { quantity: 1, condition: null, isSold: false },
      { quantity: 2, condition: null, isSold: true }, // sold — excluded
    ]);
    expect(totalCards).toBe(1);
  });

  it("graded count excludes sold lots", () => {
    const { graded } = activeCardCounts([
      { quantity: 1, condition: "PSA 10", isSold: false }, // active graded
      { quantity: 3, condition: "BGS 9.5", isSold: true }, // sold graded — excluded
      { quantity: 1, condition: "Near Mint", isSold: false }, // active raw
    ]);
    expect(graded).toBe(1);
  });

  it("sums quantities across active lots; empty input is 0/0", () => {
    expect(activeCardCounts([])).toEqual({ totalCards: 0, graded: 0 });
    const r = activeCardCounts([
      { quantity: 2, condition: null, isSold: false },
      { quantity: 3, condition: "CGC 9", isSold: false },
    ]);
    expect(r).toEqual({ totalCards: 5, graded: 3 });
  });
});
