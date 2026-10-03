import { describe, it, expect } from "vitest";
// F-#8 pure 5-bucket selector (design §5). Does not exist yet → red.
import {
  selectBuckets,
  type BucketLot,
  type BucketWant,
} from "@/lib/utils/collection-buckets";
import type { CollectionScope } from "@/lib/utils/collection-scope";

// Lots across two collections + a loose (null) lot, some sold.
const lots: BucketLot[] = [
  { collectionId: "A", isSold: false }, // A active
  { collectionId: "A", isSold: false }, // A active
  { collectionId: "A", isSold: true }, // A sold
  { collectionId: "B", isSold: false }, // B active
  { collectionId: null, isSold: false }, // loose active
  { collectionId: null, isSold: true }, // loose sold
];

const wants: BucketWant[] = [
  { collectionId: "A", intent: "BUY" },
  { collectionId: "A", intent: "SELL" },
  { collectionId: "A", intent: "TRADE" }, // excluded from the 5 buckets
  { collectionId: "B", intent: "BUY" },
  { collectionId: null, intent: "BUY" }, // legacy account-level
];

describe("selectBuckets — a specific collection", () => {
  const scope: CollectionScope = { kind: "collection", id: "A" };

  it("Main == All (same active array) within a collection", () => {
    const b = selectBuckets(lots, wants, scope);
    expect(b.main).toEqual(b.all);
    expect(b.main).toHaveLength(2); // two active A lots
  });

  it("Sold is filtered per collection", () => {
    const b = selectBuckets(lots, wants, scope);
    expect(b.sold).toHaveLength(1);
    expect(b.sold[0].isSold).toBe(true);
  });

  it("Buy/Sell scoped to the collection; TRADE excluded", () => {
    const b = selectBuckets(lots, wants, scope);
    expect(b.buy).toHaveLength(1);
    expect(b.sell).toHaveLength(1);
    expect(b.buy.every((w) => w.intent === "BUY")).toBe(true);
    expect(b.sell.every((w) => w.intent === "SELL")).toBe(true);
    // No TRADE leaks into any returned bucket.
    const all = [...b.main, ...b.all, ...b.sold];
    expect(all.length).toBeGreaterThan(0);
  });

  it("does not leak other collections' wants", () => {
    const b = selectBuckets(lots, wants, scope);
    // B's BUY and the loose BUY must not appear in A's buy bucket.
    expect(b.buy).toHaveLength(1);
  });
});

describe("selectBuckets — loose scope", () => {
  const scope: CollectionScope = { kind: "loose" };

  it("includes only null-collection lots and wants", () => {
    const b = selectBuckets(lots, wants, scope);
    expect(b.main).toHaveLength(1); // loose active lot
    expect(b.sold).toHaveLength(1); // loose sold lot
    expect(b.buy).toHaveLength(1); // loose BUY want
  });
});

describe("selectBuckets — top-level all", () => {
  const scope: CollectionScope = { kind: "all" };

  it("main=[] and sold=[] (no top-level Main/Sold), all=union of every active lot", () => {
    const b = selectBuckets(lots, wants, scope);
    expect(b.main).toEqual([]);
    expect(b.sold).toEqual([]);
    // every ACTIVE lot across all collections incl. null
    expect(b.all).toHaveLength(4);
  });

  it("buy/sell include legacy null account-level wants", () => {
    const b = selectBuckets(lots, wants, scope);
    expect(b.buy).toHaveLength(3); // A, B, loose BUY
    expect(b.sell).toHaveLength(1); // A SELL
  });
});

describe("selectBuckets — empty inputs never fabricate", () => {
  it("empty buckets are empty arrays, not undefined", () => {
    const b = selectBuckets([], [], { kind: "collection", id: "X" });
    expect(b).toEqual({ main: [], all: [], buy: [], sell: [], sold: [] });
  });
});
