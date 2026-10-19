import { describe, it, expect } from "vitest";
import { countSoldRowsByCollection, UNCATEGORIZED_ID } from "@/lib/utils/sold-bucket";

/**
 * QA #4 — the "Sold N" collection chip must agree with the Sold view's item
 * count. The chip used to sum sold QUANTITY, so a single sold lot of qty 2 read
 * "Sold 2" against the view's "1 item". countSoldRowsByCollection collapses sold
 * lots to the same consolidation granularity (one row per card+foil+condition
 * +soldPrice) and counts rows.
 */
describe("countSoldRowsByCollection", () => {
  it("a single sold lot of quantity 2 counts as 1 consolidated row (not 2)", () => {
    // Quantity is irrelevant to the row count — the util never reads it.
    const counts = countSoldRowsByCollection([
      { collectionId: "A", cardId: "bisharp", isFoil: false, condition: null, soldPrice: 12 },
    ]);
    expect(counts.get("A")).toBe(1);
  });

  it("identical sold lots (same card/foil/condition/soldPrice) merge into one row", () => {
    const counts = countSoldRowsByCollection([
      { collectionId: "A", cardId: "bisharp", isFoil: false, condition: null, soldPrice: 12 },
      { collectionId: "A", cardId: "bisharp", isFoil: false, condition: null, soldPrice: 12 },
    ]);
    expect(counts.get("A")).toBe(1);
  });

  it("differing soldPrice / foil / graded condition split into separate rows; null collection is uncategorized", () => {
    const counts = countSoldRowsByCollection([
      { collectionId: "A", cardId: "bisharp", isFoil: false, condition: null, soldPrice: 12 },
      { collectionId: "A", cardId: "bisharp", isFoil: false, condition: null, soldPrice: 15 }, // diff price
      { collectionId: "A", cardId: "bisharp", isFoil: true, condition: null, soldPrice: 12 }, // foil
      { collectionId: "A", cardId: "bisharp", isFoil: false, condition: "PSA 10", soldPrice: 12 }, // graded
      { collectionId: null, cardId: "charizard", isFoil: false, condition: null, soldPrice: 99 },
    ]);
    expect(counts.get("A")).toBe(4);
    expect(counts.get(UNCATEGORIZED_ID)).toBe(1);
  });

  it("non-graded conditions normalize to 'raw' so they merge", () => {
    const counts = countSoldRowsByCollection([
      { collectionId: "A", cardId: "bisharp", isFoil: false, condition: "Near Mint", soldPrice: 12 },
      { collectionId: "A", cardId: "bisharp", isFoil: false, condition: "Lightly Played", soldPrice: 12 },
    ]);
    expect(counts.get("A")).toBe(1);
  });
});
