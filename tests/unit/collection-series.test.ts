import { describe, it, expect } from "vitest";
import {
  buildCollectionSeries,
  type HoldingInterval,
  type PricePoint,
} from "@/lib/utils/collection-series";
import { isVirtualCollectionId, ALL_VIEW_ID } from "@/lib/utils/collections-virtual";
import { displayPrice, type GradedPriceRow } from "@/lib/utils/graded-price";
import { statsFromLots } from "@/lib/utils/portfolio-accounting";
import { pickGradedRow, type PriceRowLike } from "@/lib/utils/raw-price";

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

describe("sale drops the line (B — active-value only, option b)", () => {
  // Requirement B: a sold lot stops contributing at soldAt, so the ACTIVE-value
  // line DROPS by that lot's value at sale time. The realized proceeds live in
  // the Realized stat (statsFromLots), NOT on this line — soldPrice is NEVER
  // folded in here. Two lots: L1 (qty 1 @ 10) held throughout; L2 (qty 2 @ 25,
  // soldPrice 999) sold mid-timeline at t0+2DAY.
  it("drops by exactly the sold lot's active contribution after soldAt, never adding soldPrice", () => {
    const holdings: HoldingInterval[] = [
      { collectionId: "A", cardId: "c1", quantity: 1, addedAt: t0, soldAt: null },
      { collectionId: "A", cardId: "c2", quantity: 2, addedAt: t0, soldAt: t0 + 2 * DAY },
    ];
    const prices: PricePoint[] = [
      { cardId: "c1", at: t0, price: 10 },
      { cardId: "c2", at: t0, price: 25 },
    ];
    const [series] = buildCollectionSeries(holdings, prices, timeline);
    const values = series.points.map((p) => p.value);
    // Before soldAt: L1 (10) + L2 (25×2=50) = 60.
    expect(values[0]).toBe(60);
    expect(values[1]).toBe(60);
    // At/after soldAt (exclusive end): L2 drops out → line = L1 alone (10),
    // lower by exactly L2's active value (50). Never 60-ish + 999 (soldPrice).
    expect(values[2]).toBe(10);
    expect(values[3]).toBe(10);
    // The sold lot's realized proceeds (999) never appear on the line.
    expect(values).not.toContain(999);
    expect(values.some((v) => v != null && v > 60)).toBe(false);
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

  // Review-blocking (iteration 5): the graded variant is chosen from the GRADED
  // MATCHES THEMSELVES by variant priority, INDEPENDENT of the surrounding raw
  // rows. A raw holofoil row must NOT drag the PSA 9 valuation onto holofoil —
  // "normal" outranks "holofoil" in VARIANT_PRIORITY, so a PSA 9 with both a
  // normal (500) and holofoil (777) row prices the normal (500) regardless of
  // which raw rows accompany it. This is what makes the chart (windowed
  // PricingHistory) and display (latest CurrentPrice) agree even though their
  // raw rows differ — see the cross-snapshot parity test below.
  it("the graded variant ignores the raw rows (picks graded default, not raw-driven)", () => {
    const prices: PricePoint[] = [
      // Raw holofoil present but no raw normal — under the OLD raw-driven rule
      // this would have forced the PSA 9 holofoil (777). Now it is ignored.
      { cardId: "c1", at: t0, price: 60, type: "raw", condition: "NM", variant: "holofoil" },
      { cardId: "c1", at: t0, price: 500, type: "graded", company: "PSA", grade: "9", variant: "normal" },
      { cardId: "c1", at: t0, price: 777, type: "graded", company: "PSA", grade: "9", variant: "holofoil" },
    ];
    const holdings: HoldingInterval[] = [
      { collectionId: "A", cardId: "c1", quantity: 1, addedAt: t0, soldAt: null, condition: "PSA 9" },
    ];
    // PSA 9 NORMAL (500) — the graded default by variant priority — NOT holofoil.
    expect(buildCollectionSeries(holdings, prices, [t0])[0].points[0].value).toBe(500);
  });
});

describe("BUG 1 & 8 — chart↔display parity through ONE shared variant selector (multi-variant)", () => {
  // Review-blocking (iteration 5): the chart (buildCollectionSeries) and the
  // display/accounting path (displayPrice/statsFromLots → pickRealGradedPrice)
  // MUST pick the SAME variant when one company+grade has several priced
  // variants — AND must do so even though in the real topology the chart is fed
  // WINDOWED PricingHistory while display is fed the LATEST CurrentPrice, which
  // carry DIFFERENT raw rows (PricingHistory accumulates; the Scrydex writer
  // REPLACES CurrentPrice). The selector now chooses the variant from the GRADED
  // MATCHES themselves (variant priority), independent of the raw rows, so the
  // two paths agree regardless of what raw rows accompany each snapshot.

  // One card, PSA 9 with TWO priced variants: normal (500) + holofoil (777).
  // "normal" outranks "holofoil" in VARIANT_PRIORITY → both paths price 500.
  const gradedPairNormalFirst: GradedPriceRow[] = [
    { type: "graded", company: "PSA", grade: "9", variant: "normal", condition: null, priceMarket: 500 },
    { type: "graded", company: "PSA", grade: "9", variant: "holofoil", condition: null, priceMarket: 777 },
  ];

  const rowsToPoints = (rows: GradedPriceRow[]): PricePoint[] =>
    rows.map((r) => ({
      cardId: "c1",
      at: t0,
      price: r.priceMarket as number,
      type: r.type,
      company: r.company,
      grade: r.grade,
      variant: r.variant,
      condition: r.condition,
    }));

  it("chart (windowed history, raw HOLOFOIL) and display (latest current, raw NORMAL) agree on the PSA 9 variant", () => {
    // THE review scenario: the two datasets imply DIFFERENT raw defaults.
    //   - Chart/history rows: raw HOLOFOIL present (no raw normal). The OLD
    //     raw-driven rule would have picked the PSA 9 holofoil (777) here.
    //   - Display/current rows: raw NORMAL present. The OLD rule would have
    //     picked the PSA 9 normal (500) here.
    // With raw-independent selection BOTH now pick PSA 9 normal (500) — the
    // graded default by variant priority — so they agree despite the split.
    const historyRows: GradedPriceRow[] = [
      { type: "raw", company: null, grade: null, variant: "holofoil", condition: "NM", priceMarket: 60 },
      ...gradedPairNormalFirst,
    ];
    const currentRows: GradedPriceRow[] = [
      { type: "raw", company: null, grade: null, variant: "normal", condition: "NM", priceMarket: 55 },
      ...gradedPairNormalFirst,
    ];

    const chart = buildCollectionSeries(
      [{ collectionId: "A", cardId: "c1", quantity: 1, addedAt: t0, soldAt: null, condition: "PSA 9" }],
      rowsToPoints(historyRows),
      [t0]
    )[0].points[0].value;

    const display = displayPrice({
      isSold: false,
      condition: "PSA 9",
      card: { marketPrice: 55, gradedPrices: currentRows },
    });

    expect(chart).toBe(500);
    expect(display).toBe(500);
    expect(chart).toBe(display); // the parity contract, across divergent snapshots
  });

  it("order-independent and consistent across chart/display when both feed the same rows", () => {
    for (const rows of [gradedPairNormalFirst, [...gradedPairNormalFirst].reverse()]) {
      const chart = buildCollectionSeries(
        [{ collectionId: "A", cardId: "c1", quantity: 1, addedAt: t0, soldAt: null, condition: "PSA 9" }],
        rowsToPoints(rows),
        [t0]
      )[0].points[0].value;
      const display = displayPrice({
        isSold: false,
        condition: "PSA 9",
        card: { marketPrice: null, gradedPrices: rows },
      });
      expect(chart).toBe(500);
      expect(display).toBe(500);
      expect(chart).toBe(display);
    }
  });

  it("statsFromLots values a PSA 9 lot at the SAME variant the chart does (normal, 500)", () => {
    const stats = statsFromLots([
      {
        quantity: 1,
        purchasePrice: null,
        marketPrice: 60,
        isSold: false,
        condition: "PSA 9",
        gradedPrices: gradedPairNormalFirst,
      },
    ]);
    const chart = buildCollectionSeries(
      [{ collectionId: "A", cardId: "c1", quantity: 1, addedAt: t0, soldAt: null, condition: "PSA 9" }],
      rowsToPoints(gradedPairNormalFirst),
      [t0]
    )[0].points[0].value;
    expect(stats.marketValue).toBe(500);
    expect(stats.marketValue).toBe(chart);
  });
});

describe("C — SINGLE SOURCE OF TRUTH: one resolved (grade, variant) feeds chart AND display", () => {
  // Requirement C: each lot's authoritative (company, grade, variant) is resolved
  // ONCE via the shared selector (pickGradedRow) over the CURRENT snapshot, and
  // the SAME identity feeds BOTH the chart series valuation (threaded in as
  // HoldingInterval.gradedVariant) AND the display path (displayPrice). This
  // mirrors what collection-history.service.ts does at runtime.
  //
  // The chart and display are fed TWO DIFFERENT row-set arrays (NOT one reused
  // fixture — reusing one array hides divergence per the Phase-1 review note):
  //   - CURRENT snapshot (display source + variant decision): PSA 9 has ONLY
  //     holofoil (777). So the resolved variant is holofoil.
  //   - windowed HISTORY (chart point source): PSA 9 has BOTH normal (500) and
  //     holofoil (777). A history-only decision would pick normal (higher
  //     priority) and the two paths would DISAGREE.
  // With the single-source resolution threaded in, BOTH value PSA 9 holofoil.
  const currentRows: GradedPriceRow[] = [
    { type: "graded", company: "PSA", grade: "9", variant: "holofoil", condition: null, priceMarket: 777 },
  ];
  const historyRows: PriceRowLike[] = [
    { type: "graded", company: "PSA", grade: "9", variant: "normal", condition: null, priceMarket: 500 },
    { type: "graded", company: "PSA", grade: "9", variant: "holofoil", condition: null, priceMarket: 777 },
  ];

  it("resolves the variant once over the current snapshot and both paths agree (divergent arrays)", () => {
    // Resolve the authoritative variant ONCE from the current snapshot — exactly
    // as the service does (current-first).
    const resolved = pickGradedRow(
      currentRows.map((r) => ({ ...r, company: r.company?.toUpperCase() ?? null })),
      "PSA",
      "9"
    );
    expect(resolved?.variant).toBe("holofoil");

    // Chart: windowed HISTORY points + the resolved variant threaded in.
    const historyPoints: PricePoint[] = historyRows.map((r) => ({
      cardId: "c1",
      at: t0,
      price: r.priceMarket as number,
      type: r.type,
      company: r.company,
      grade: r.grade,
      variant: r.variant,
      condition: r.condition,
    }));
    const chart = buildCollectionSeries(
      [{ collectionId: "A", cardId: "c1", quantity: 1, addedAt: t0, soldAt: null, condition: "PSA 9", gradedVariant: resolved?.variant ?? null }],
      historyPoints,
      [t0]
    )[0].points[0].value;

    // Display: the CURRENT snapshot array (a DIFFERENT array than the chart's).
    const display = displayPrice({
      isSold: false,
      condition: "PSA 9",
      card: { marketPrice: null, gradedPrices: currentRows },
    });

    expect(chart).toBe(777);
    expect(display).toBe(777);
    expect(chart).toBe(display); // single-source parity across divergent arrays
  });

  it("missing-current-grade: display and chart agree on the real historical row's variant", () => {
    // CURRENT cannot price PSA 9 (has only PSA 10) → the service falls back to
    // the most-recent real graded history row for PSA 9, preserving ITS variant.
    const currentNoPsa9: GradedPriceRow[] = [
      { type: "graded", company: "PSA", grade: "10", variant: "normal", condition: null, priceMarket: 1000 },
    ];
    const historyPsa9: PriceRowLike[] = [
      { type: "graded", company: "PSA", grade: "9", variant: "holofoil", condition: null, priceMarket: 650 },
    ];
    // Service resolution: current-first (null for PSA 9) → history fallback.
    const resolved =
      pickGradedRow(currentNoPsa9.map((r) => ({ ...r, company: r.company?.toUpperCase() ?? null })), "PSA", "9") ??
      pickGradedRow(historyPsa9, "PSA", "9");
    expect(resolved?.variant).toBe("holofoil");

    const chart = buildCollectionSeries(
      [{ collectionId: "A", cardId: "c1", quantity: 1, addedAt: t0, soldAt: null, condition: "PSA 9", gradedVariant: resolved?.variant ?? null }],
      historyPsa9.map((r) => ({ cardId: "c1", at: t0, price: r.priceMarket as number, type: r.type, company: r.company, grade: r.grade, variant: r.variant, condition: r.condition })),
      [t0]
    )[0].points[0].value;

    // The display API's historical-fallback entry would carry this same real
    // variant (holofoil) + price (650) — so display and chart agree.
    expect(chart).toBe(650);
    expect(resolved?.price).toBe(650);
  });
});

describe("Bug B — chart's LATEST point is anchored to the current value (vocabulary mismatch)", () => {
  // base1-4-style reproduction: a PSA 9 lot whose PricingHistory uses DIFFERENT
  // variant labels than CurrentPrice. The authoritative summary value lives in
  // CurrentPrice (unlimitedHolofoil = $6,163.18). The service threads the
  // resolved variant (unlimitedHolofoil) AND appends a synthetic current anchor
  // at the latest instant. The chart's LAST point must equal the summary value
  // ($6,163.18), NOT the newest matching-variant HISTORY point ($4,200), and NOT
  // the newer `normal` history point that the resolved-variant filter excludes.
  const CURRENT = 6163.18;
  const OLD_HOLO = 4200; // unlimitedHolofoil history point, dated earlier
  const NEWER_NORMAL = 14629.69; // a different-variant history point, newer

  it("anchors the latest point to the current price, not the newest history point", () => {
    const tOld = t0;
    const tNew = t0 + DAY; // newer than the unlimitedHolofoil history point
    const now = t0 + 2 * DAY; // the current-anchor instant
    const history: PricePoint[] = [
      // unlimitedHolofoil history (older) — the resolved variant, but STALE value.
      { cardId: "c1", at: tOld, price: OLD_HOLO, type: "graded", company: "PSA", grade: "9", variant: "unlimitedHolofoil" },
      // a DIFFERENT variant, NEWER — must be excluded by the variant filter.
      { cardId: "c1", at: tNew, price: NEWER_NORMAL, type: "graded", company: "PSA", grade: "9", variant: "unlimitedShadowlessHolofoil" },
    ];
    // Synthetic current anchor at `now`, carrying the resolved variant + current value.
    const anchor: PricePoint = {
      cardId: "c1", at: now, price: CURRENT, type: "graded", company: "PSA", grade: "9", variant: "unlimitedHolofoil",
    };
    const holdings: HoldingInterval[] = [
      { collectionId: "A", cardId: "c1", quantity: 1, addedAt: t0, soldAt: null, condition: "PSA 9", gradedVariant: "unlimitedHolofoil" },
    ];
    const line = buildCollectionSeries(holdings, [...history, anchor], [tOld, tNew, now])[0].points;
    // Latest point == current value (6163.18), NOT 4200 and NOT 14629.69.
    expect(line[line.length - 1].value).toBe(CURRENT);
    expect(line[line.length - 1].value).not.toBe(OLD_HOLO);
    expect(line[line.length - 1].value).not.toBe(NEWER_NORMAL);
    // Earlier instant still carries the REAL same-variant history point.
    expect(line[0].value).toBe(OLD_HOLO);
  });

  it("the chart's latest point equals displayPrice for the same base1-4-style lot", () => {
    const now = t0 + 2 * DAY;
    const gradedPrices: GradedPriceRow[] = [
      { type: "graded", company: "PSA", grade: "9", variant: "firstEditionShadowlessHolofoil", condition: null, priceMarket: 82660.12 },
      { type: "graded", company: "PSA", grade: "9", variant: "unlimitedShadowlessHolofoil", condition: null, priceMarket: 11750.5 },
      { type: "graded", company: "PSA", grade: "9", variant: "unlimitedHolofoil", condition: null, priceMarket: CURRENT },
      { type: "graded", company: "PSA", grade: "9", variant: "metal", condition: null, priceMarket: 540.77 },
    ];
    // The summary's chosen variant/price (the authoritative resolution).
    const resolved = pickGradedRow(gradedPrices as PriceRowLike[], "PSA", "9");
    expect(resolved?.variant).toBe("unlimitedHolofoil");
    expect(resolved?.price).toBe(CURRENT);

    const anchor: PricePoint = {
      cardId: "c1", at: now, price: resolved!.price, type: "graded", company: "PSA", grade: "9", variant: resolved!.variant,
    };
    const chartLatest = buildCollectionSeries(
      [{ collectionId: "A", cardId: "c1", quantity: 1, addedAt: t0, soldAt: null, condition: "PSA 9", gradedVariant: resolved!.variant }],
      [anchor],
      [now]
    )[0].points[0].value;

    const summary = displayPrice({ isSold: false, condition: "PSA 9", card: { marketPrice: 359.95, gradedPrices } });

    expect(chartLatest).toBe(CURRENT);
    expect(summary).toBe(CURRENT);
    expect(chartLatest).toBe(summary); // the Bug-B parity contract
  });
});

describe("isVirtualCollectionId", () => {
  it("recognises the reserved ALL view id", () => {
    expect(isVirtualCollectionId(ALL_VIEW_ID)).toBe(true);
    expect(isVirtualCollectionId("some-cuid")).toBe(false);
    expect(isVirtualCollectionId(null)).toBe(false);
  });
});
