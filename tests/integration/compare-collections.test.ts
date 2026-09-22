import { describe, it, expect } from "vitest";

/**
 * F-22 — Compare Collections. RED phase.
 *
 * Supabase (PostgreSQL) + Prisma — no Firebase. This pins the pure
 * comparison contract that the Compare Collections UI will render. It
 * builds on the existing F-11 aggregator (aggregateCollectionStats): given
 * the user's owned items and TWO collection ids, it returns their stats
 * side by side, and it exposes a guard for the "need at least two
 * collections" case.
 *
 * Kept pure (no Prisma, no network) so it mirrors the existing
 * collection-aggregation tests and defines behaviour without a migration.
 *
 * EXPECTED TO FAIL today: `@/lib/utils/compare-collections` does not exist.
 */

import {
  compareCollections,
  canCompare,
  MIN_COLLECTIONS_TO_COMPARE,
  NEEDS_MORE_COLLECTIONS_MESSAGE,
  type ComparableItem,
} from "@/lib/utils/compare-collections";

// Owned rows across two collections; one item has no collection (should be
// ignored by a specific-collection comparison).
const items: ComparableItem[] = [
  { quantity: 2, collectionId: "A", card: { marketPrice: 100 } }, // A: 200
  { quantity: 1, collectionId: "A", card: { marketPrice: 50 } },  // A: 50
  { quantity: 3, collectionId: "B", card: { marketPrice: 20 } },  // B: 60
  { quantity: 1, collectionId: null, card: { marketPrice: 40 } }, // neither
];

describe("compareCollections — happy path", () => {
  it("returns side-by-side value + count for both collections", () => {
    const result = compareCollections(items, "A", "B");

    // Collection A: 2*100 + 1*50 = 250, count 3
    expect(result.a.totalValue).toBe(250);
    expect(result.a.cardCount).toBe(3);

    // Collection B: 3*20 = 60, count 3
    expect(result.b.totalValue).toBe(60);
    expect(result.b.cardCount).toBe(3);
  });

  it("echoes back which collection id sits on each side", () => {
    const result = compareCollections(items, "A", "B");
    expect(result.a.collectionId).toBe("A");
    expect(result.b.collectionId).toBe("B");
  });

  it("does not leak un-collected items into either side", () => {
    const result = compareCollections(items, "A", "B");
    // The null-collection $40 card belongs to neither side.
    expect(result.a.totalValue + result.b.totalValue).toBe(310); // 250 + 60
  });
});

describe("compareCollections — empty collection handling", () => {
  it("shows $0.00 / 0 for an empty collection without throwing", () => {
    const result = compareCollections(items, "A", "empty");
    expect(result.a.totalValue).toBe(250);
    expect(result.b.totalValue).toBe(0);
    expect(result.b.cardCount).toBe(0);
  });

  it("handles both sides empty and an empty item list gracefully", () => {
    const result = compareCollections([], "x", "y");
    expect(result.a.totalValue).toBe(0);
    expect(result.a.cardCount).toBe(0);
    expect(result.b.totalValue).toBe(0);
    expect(result.b.cardCount).toBe(0);
  });
});

describe("canCompare — needs at least two collections", () => {
  it("requires two collections to compare", () => {
    expect(MIN_COLLECTIONS_TO_COMPARE).toBe(2);
    expect(canCompare(0)).toBe(false);
    expect(canCompare(1)).toBe(false);
    expect(canCompare(2)).toBe(true);
    expect(canCompare(5)).toBe(true);
  });

  it("exposes a clear prompt to add another collection", () => {
    expect(NEEDS_MORE_COLLECTIONS_MESSAGE).toMatch(/add another collection/i);
  });
});
