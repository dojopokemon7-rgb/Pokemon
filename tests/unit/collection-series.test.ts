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

describe("BUG 1 & 8 — a lot is valued from the price series matching ITS OWN grade", () => {
  // One cardId with raw + PSA 9 + PSA 10 + CGC 10 rows at the SAME instant.
  // Before the fix, carry-forward kept whichever row sorted last, so every lot
  // of this card took the same (wrong) price. Each lot must now resolve to its
  // own grade's price, never the mixed/last-sorted value.
  const prices: PricePoint[] = [
    { cardId: "c1", at: t0, price: 50, type: "raw", condition: "NM", variant: "normal" },
    { cardId: "c1", at: t0, price: 500, type: "graded", company: "PSA", grade: "9", variant: "normal" },
    { cardId: "c1", at: t0, price: 1000, type: "graded", company: "PSA", grade: "10", variant: "normal" },
    { cardId: "c1", at: t0, price: 900, type: "graded", company: "CGC", grade: "10", variant: "normal" },
  ];

  const valueAt = (condition: string | null) => {
    const holdings: HoldingInterval[] = [
      { collectionId: "A", cardId: "c1", quantity: 1, addedAt: t0, soldAt: null, condition },
    ];
    const [series] = buildCollectionSeries(holdings, prices, [t0]);
    return series.points[0].value;
  };

  it("values a PSA 9 lot at the PSA 9 price", () => {
    expect(valueAt("PSA 9")).toBe(500);
  });

  it("values a PSA 10 lot at the PSA 10 price", () => {
    expect(valueAt("PSA 10")).toBe(1000);
  });

  it("values a CGC 10 lot at the CGC 10 price (not PSA 10, not the last-sorted row)", () => {
    expect(valueAt("CGC 10")).toBe(900);
  });

  it("values a raw lot (null condition) at the raw price", () => {
    expect(valueAt(null)).toBe(50);
  });

  it("three lots of the one card each take their own grade in a single series total", () => {
    const holdings: HoldingInterval[] = [
      { collectionId: "A", cardId: "c1", quantity: 1, addedAt: t0, soldAt: null, condition: "PSA 9" },
      { collectionId: "A", cardId: "c1", quantity: 1, addedAt: t0, soldAt: null, condition: "PSA 10" },
      { collectionId: "A", cardId: "c1", quantity: 1, addedAt: t0, soldAt: null, condition: null },
    ];
    const [series] = buildCollectionSeries(holdings, prices, [t0]);
    // 500 (PSA 9) + 1000 (PSA 10) + 50 (raw) = 1550 — never 3× the same value.
    expect(series.points[0].value).toBe(1550);
  });

  it("a graded lot with no matching graded row stays an honest null gap (no raw fallback)", () => {
    // BGS 10 has no stored row → honest gap, not silently valued at raw/PSA.
    expect(valueAt("BGS 10")).toBeNull();
  });

  it("legacy points without type/condition still behave as raw (no regression)", () => {
    const legacy: PricePoint[] = [{ cardId: "c1", at: t0, price: 42 }];
    const holdings: HoldingInterval[] = [
      { collectionId: "A", cardId: "c1", quantity: 2, addedAt: t0, soldAt: null },
    ];
    const [series] = buildCollectionSeries(holdings, legacy, [t0]);
    expect(series.points[0].value).toBe(84); // 42 × 2, raw as before
  });

  // Review-blocking: two priced variants at the SAME recordedAt under ONE
  // company+grade must resolve to a DETERMINISTIC variant (the same
  // default-variant rule pickGradedFromRows / statsFromLots use), not whichever
  // row sorts last in DB/array order. "normal" outranks "holofoil" in the
  // variant priority, so a PSA 9 lot must value at the "normal" price (500)
  // regardless of the order the rows arrive in.
  it("a PSA 9 lot picks the default variant deterministically regardless of row order", () => {
    const makePrices = (order: "normal-first" | "holo-first"): PricePoint[] => {
      const normal: PricePoint = {
        cardId: "c1", at: t0, price: 500, type: "graded", company: "PSA", grade: "9", variant: "normal",
      };
      const holo: PricePoint = {
        cardId: "c1", at: t0, price: 777, type: "graded", company: "PSA", grade: "9", variant: "holofoil",
      };
      return order === "normal-first" ? [normal, holo] : [holo, normal];
    };
    const valueFor = (ps: PricePoint[]) => {
      const holdings: HoldingInterval[] = [
        { collectionId: "A", cardId: "c1", quantity: 1, addedAt: t0, soldAt: null, condition: "PSA 9" },
      ];
      return buildCollectionSeries(holdings, ps, [t0])[0].points[0].value;
    };
    // Opposite orders → identical deterministic result (the "normal" variant).
    expect(valueFor(makePrices("normal-first"))).toBe(500);
    expect(valueFor(makePrices("holo-first"))).toBe(500);
  });

  // Review-blocking (iteration 3): display/accounting (pickGradedFromRows)
  // derive the card default variant from the card's FULL row set, so a RAW row
  // can make a non-normal variant (holofoil) the card default. The chart MUST
  // mirror that rule — deriving the graded variant from graded-only rows would
  // pick "normal" by variant priority and DISAGREE with the displayed value for
  // every card with this shape. Here a raw HOLOFOIL row establishes holofoil as
  // the card default, and PSA 9 has BOTH a normal (500) and a holofoil (777)
  // row: display prices the PSA 9 holofoil (777), so the chart must too.
  it("a graded lot follows the card default variant set by a RAW row (chart↔display parity)", () => {
    const prices: PricePoint[] = [
      // Raw holofoil present but no raw normal → holofoil is the card default.
      { cardId: "c1", at: t0, price: 60, type: "raw", condition: "NM", variant: "holofoil" },
      { cardId: "c1", at: t0, price: 500, type: "graded", company: "PSA", grade: "9", variant: "normal" },
      { cardId: "c1", at: t0, price: 777, type: "graded", company: "PSA", grade: "9", variant: "holofoil" },
    ];
    const holdings: HoldingInterval[] = [
      { collectionId: "A", cardId: "c1", quantity: 1, addedAt: t0, soldAt: null, condition: "PSA 9" },
    ];
    // Must be the PSA 9 HOLOFOIL price (777) — the variant the raw row made the
    // card default — NOT "normal" (500) that a graded-only derivation would pick.
    expect(buildCollectionSeries(holdings, prices, [t0])[0].points[0].value).toBe(777);
  });
});

describe("isVirtualCollectionId", () => {
  it("recognises the reserved ALL view id", () => {
    expect(isVirtualCollectionId(ALL_VIEW_ID)).toBe(true);
    expect(isVirtualCollectionId("some-cuid")).toBe(false);
    expect(isVirtualCollectionId(null)).toBe(false);
  });
});
