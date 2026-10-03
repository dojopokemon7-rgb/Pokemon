import { describe, it, expect } from "vitest";
// F-11 target contract: a pure aggregator that computes the dashboard's
// headline stats for either ALL collections or a single selected one.
// Does not exist yet → red.
import {
  aggregateCollectionStats,
  ALL_COLLECTIONS,
  type AggregatableItem,
} from "@/lib/utils/collection-aggregation";
// F-#8: the dual-All resolver must agree with the aggregator's scoping.
import { toScope, activeWhere } from "@/lib/utils/collection-scope";

// Minimal item shape the dashboard already has (card marketPrice, quantity,
// purchasePrice) plus the F-10 collectionId used to scope the view.
const items: AggregatableItem[] = [
  { quantity: 2, purchasePrice: 10, collectionId: "holo", card: { marketPrice: 100 } },
  { quantity: 1, purchasePrice: 5, collectionId: "holo", card: { marketPrice: 50 } },
  { quantity: 3, purchasePrice: 1, collectionId: "op", card: { marketPrice: 20 } },
  { quantity: 1, purchasePrice: 0, collectionId: null, card: { marketPrice: 40 } },
];

describe("aggregateCollectionStats — default (All Collections)", () => {
  it("sums market value across every item regardless of collection", () => {
    const stats = aggregateCollectionStats(items, ALL_COLLECTIONS);
    // 2*100 + 1*50 + 3*20 + 1*40 = 350
    expect(stats.totalValue).toBe(350);
  });

  it("counts every card (sum of quantities)", () => {
    const stats = aggregateCollectionStats(items, ALL_COLLECTIONS);
    expect(stats.cardCount).toBe(7); // 2 + 1 + 3 + 1
  });

  it("produces chart data points for the aggregated value", () => {
    const stats = aggregateCollectionStats(items, ALL_COLLECTIONS);
    expect(Array.isArray(stats.chartData)).toBe(true);
    expect(stats.chartData.length).toBeGreaterThan(0);
  });
});

describe("aggregateCollectionStats — specific collection", () => {
  it("scopes value + counts to the selected collection only", () => {
    const stats = aggregateCollectionStats(items, "holo");
    // Only the two "holo" rows: 2*100 + 1*50 = 250, count 3
    expect(stats.totalValue).toBe(250);
    expect(stats.cardCount).toBe(3);
  });

  it("does not include items from other collections", () => {
    const stats = aggregateCollectionStats(items, "op");
    expect(stats.totalValue).toBe(60); // 3*20
    expect(stats.cardCount).toBe(3);
  });
});

describe("dual-All contract (F-#8) — scope resolver agrees with the aggregator", () => {
  it("in-collection All resolves to the SAME where as Main (collectionId + isSold:false)", () => {
    // toScope("<id>") → {kind:"collection"} → activeWhere pins the exact Main where.
    expect(activeWhere("user_123", toScope("holo"))).toEqual({
      userId: "user_123",
      isSold: false,
      collectionId: "holo",
    });
  });

  it("top-level All (ALL_COLLECTIONS) still sums across collectionId:null rows", () => {
    // The aggregator's top-level All includes the loose (null) $40 card.
    const stats = aggregateCollectionStats(items, ALL_COLLECTIONS);
    expect(stats.totalValue).toBe(350); // 250 holo + 60 op + 40 loose
    // And the resolver maps the same signal to a where with NO collectionId key.
    expect(activeWhere("user_123", toScope(ALL_COLLECTIONS))).toEqual({
      userId: "user_123",
      isSold: false,
    });
  });
});

describe("aggregateCollectionStats — empty state", () => {
  it("returns $0 value, 0 count, and non-crashing empty chart for a collection with no cards", () => {
    const stats = aggregateCollectionStats(items, "does-not-exist");
    expect(stats.totalValue).toBe(0);
    expect(stats.cardCount).toBe(0);
    expect(Array.isArray(stats.chartData)).toBe(true); // empty state, not a throw
  });

  it("handles an empty item list without crashing", () => {
    const stats = aggregateCollectionStats([], ALL_COLLECTIONS);
    expect(stats.totalValue).toBe(0);
    expect(stats.cardCount).toBe(0);
  });
});
