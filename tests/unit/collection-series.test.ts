import { describe, it, expect } from "vitest";
import {
  buildCollectionSeries,
  type HoldingInterval,
  type PricePoint,
} from "@/lib/utils/collection-series";
import { isVirtualCollectionId, ALL_VIEW_ID } from "@/lib/utils/collections-virtual";

const DAY = 24 * 60 * 60 * 1000;
const t0 = 1_700_000_000_000; // arbitrary epoch base
const timeline = [t0, t0 + DAY, t0 + 2 * DAY, t0 + 3 * DAY];

describe("buildCollectionSeries (plan §6 honesty rules)", () => {
  it("never values a card before it entered the collection (null gap pre-ownership)", () => {
    const holdings: HoldingInterval[] = [
      { collectionId: "A", cardId: "c1", quantity: 1, addedAt: t0 + 2 * DAY, soldAt: null },
    ];
    const prices: PricePoint[] = [{ cardId: "c1", at: t0, price: 10 }];
    const [series] = buildCollectionSeries(holdings, prices, timeline);
    // Before addedAt (t0, t0+DAY) → null; from addedAt onward → valued.
    expect(series.points.map((p) => p.value)).toEqual([null, null, 10, 10]);
  });

  it("stops valuing a lot once sold ([addedAt, soldAt) exclusive end)", () => {
    const holdings: HoldingInterval[] = [
      { collectionId: "A", cardId: "c1", quantity: 2, addedAt: t0, soldAt: t0 + 2 * DAY },
    ];
    const prices: PricePoint[] = [{ cardId: "c1", at: t0, price: 5 }];
    const [series] = buildCollectionSeries(holdings, prices, timeline);
    // Owned at t0, t0+DAY (value 10); sold at t0+2DAY → excluded → null.
    expect(series.points.map((p) => p.value)).toEqual([10, 10, null, null]);
  });

  it("carries forward the nearest real price at/before t; honest gap when none", () => {
    const holdings: HoldingInterval[] = [
      { collectionId: "A", cardId: "c1", quantity: 1, addedAt: t0, soldAt: null },
    ];
    // First real price only appears at t0+DAY → t0 is a gap (null), not fabricated.
    const prices: PricePoint[] = [
      { cardId: "c1", at: t0 + DAY, price: 20 },
      { cardId: "c1", at: t0 + 3 * DAY, price: 30 },
    ];
    const [series] = buildCollectionSeries(holdings, prices, timeline);
    expect(series.points.map((p) => p.value)).toEqual([null, 20, 20, 30]);
  });

  it("produces one series PER collection and never sums across them", () => {
    const holdings: HoldingInterval[] = [
      { collectionId: "A", cardId: "c1", quantity: 1, addedAt: t0, soldAt: null },
      { collectionId: "B", cardId: "c2", quantity: 1, addedAt: t0, soldAt: null },
    ];
    const prices: PricePoint[] = [
      { cardId: "c1", at: t0, price: 10 },
      { cardId: "c2", at: t0, price: 99 },
    ];
    const out = buildCollectionSeries(holdings, prices, [t0]);
    expect(out).toHaveLength(2);
    const a = out.find((s) => s.collectionId === "A")!;
    const b = out.find((s) => s.collectionId === "B")!;
    expect(a.points[0].value).toBe(10); // NOT 109 — never summed
    expect(b.points[0].value).toBe(99);
  });
});

describe("Sold-per-collection at the series layer (F-#8 FR-5.2)", () => {
  it("a NAMED-collection sold lot's [addedAt, soldAt) interval stays in that collection's series", () => {
    const holdings: HoldingInterval[] = [
      { collectionId: "col_A", cardId: "c1", quantity: 1, addedAt: t0, soldAt: t0 + 2 * DAY },
    ];
    const prices: PricePoint[] = [{ cardId: "c1", at: t0, price: 7 }];
    const out = buildCollectionSeries(holdings, prices, timeline);
    const a = out.find((s) => s.collectionId === "col_A")!;
    // Owned t0, t0+DAY (value 7); sold at t0+2DAY → excluded → null.
    expect(a.points.map((p) => p.value)).toEqual([7, 7, null, null]);
  });

  it("a loose sold lot fed as collectionId:'null' (the real string sentinel) lands in the 'null' series", () => {
    // The real caller (history/route.ts) builds HoldingInterval.collectionId
    // from the query-string sentinel "null" for loose lots — NOT raw JS null,
    // NOT "__uncat__".
    const holdings: HoldingInterval[] = [
      { collectionId: "null", cardId: "c1", quantity: 2, addedAt: t0, soldAt: t0 + DAY },
    ];
    const prices: PricePoint[] = [{ cardId: "c1", at: t0, price: 5 }];
    const out = buildCollectionSeries(holdings, prices, timeline);
    const loose = out.find((s) => s.collectionId === "null")!;
    expect(loose).toBeDefined();
    // Owned at t0 (value 10); sold at t0+DAY → excluded afterward.
    expect(loose.points.map((p) => p.value)).toEqual([10, null, null, null]);
  });
});

describe("isVirtualCollectionId", () => {
  it("recognises the reserved ALL view id", () => {
    expect(isVirtualCollectionId(ALL_VIEW_ID)).toBe(true);
    expect(isVirtualCollectionId("some-cuid")).toBe(false);
    expect(isVirtualCollectionId(null)).toBe(false);
  });
});
