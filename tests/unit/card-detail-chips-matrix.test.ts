import { describe, it, expect } from "vitest";
import {
  buildChips,
  buildChartMatrix,
  fmtChartDate,
  rangeAvailability,
  seriesSpanDays,
  maxAvailableSpanDays,
  largestEnabledRange,
  type Chip,
  type HistoryResponse,
} from "@/app/(dashboard)/search/[id]/price-history-chart";

/**
 * FEAT-002 — pure buildChips + buildChartMatrix helpers for the card-detail
 * Price History UI. These are the ONE runnable check that the chip grouping,
 * id-scheme, numeric price read, and the dense (>=2-rows-per-series, no
 * NaN/undefined) multi-series matrix hold — the AreaChart multi-series mode
 * poisons the shared scale on any undefined/NaN, so every datum MUST be a real
 * number (see context.json key_patterns).
 */

const GOLD = "var(--color-dojo-gold)";
const JADE = "var(--color-dojo-jade)";
const VERM = "var(--color-dojo-vermilion)";

describe("buildChips", () => {
  it("always emits a Raw chip first with the raw price from chipPrice", () => {
    const groups = buildChips([], { raw: 12.5 });
    expect(groups[0].group).toBe("Raw");
    const raw = groups[0].chips[0];
    expect(raw.id).toBe("raw");
    expect(raw.company).toBeNull();
    expect(raw.grade).toBe("Raw");
    expect(raw.price).toBe(12.5);
    expect(raw.color).toBe("#9AA0A6");
  });

  it("builds one chip per present (company, grade) graded row, PSA-first", () => {
    const groups = buildChips(
      [
        { type: "graded", company: "CGC", grade: "9.5", priceMarket: 300 },
        { type: "graded", company: "PSA", grade: "10", priceMarket: 1000 },
        { type: "graded", company: "PSA", grade: "9", priceMarket: 500 },
        { type: "raw", condition: "NM", priceMarket: 50 },
      ],
      { raw: 50 }
    );
    // Raw group first, then PSA (PSA-first), then CGC.
    expect(groups.map((g) => g.group)).toEqual(["Raw", "PSA", "CGC"]);
    const psa = groups.find((g) => g.group === "PSA")!;
    // grades sorted desc: 10 then 9
    expect(psa.chips.map((c) => c.grade)).toEqual(["10", "9"]);
    const psa10 = psa.chips[0];
    expect(psa10.id).toBe("PSA|10");
    expect(psa10.company).toBe("PSA");
    expect(psa10.price).toBe(1000); // NUMERIC from currentPrices, not a string
  });

  it("reads the chip price NUMERICALLY (priceMarket ?? priceLow) and nulls when absent", () => {
    const groups = buildChips(
      [
        { type: "graded", company: "PSA", grade: "10", priceMarket: null, priceLow: 800 },
        { type: "graded", company: "PSA", grade: "9", priceMarket: null, priceLow: null },
      ],
      { raw: null }
    );
    const psa = groups.find((g) => g.group === "PSA")!;
    const byGrade = Object.fromEntries(psa.chips.map((c) => [c.grade, c.price]));
    expect(byGrade["10"]).toBe(800); // falls back to priceLow
    expect(byGrade["9"]).toBeNull(); // both null -> null (renders "—")
  });

  it("uppercases company in the chip id but keeps grade verbatim", () => {
    const groups = buildChips(
      [{ type: "graded", company: "cgc", grade: "9.5", priceMarket: 1 }],
      { raw: 1 }
    );
    const cgc = groups.find((g) => g.group === "CGC")!;
    expect(cgc.chips[0].id).toBe("CGC|9.5");
  });

  // FEAT-002 regression guard: a raw-only card (NO stored graded CurrentPrice
  // row) must show the Raw chip ONLY — even if chipPrice still carries PSA|10 /
  // PSA|9 keys (e.g. a leftover fallback estimate). The old chipPrice->PSA-seed
  // loop fabricated identical PSA 10/9 chips on every priced card; it is gone,
  // so graded chips derive solely from real currentPrices graded rows. (The
  // Mew ex me55-152 case: priced, no graded rows → Raw only.)
  it("emits Raw ONLY for a raw-only card even when chipPrice carries PSA keys (no fabricated graded chip)", () => {
    const groups = buildChips(
      [{ type: "raw", condition: "NM", priceMarket: 40 }],
      { raw: 40, "PSA|10": 100, "PSA|9": 60 }
    );
    expect(groups.map((g) => g.group)).toEqual(["Raw"]);
    expect(groups.flatMap((g) => g.chips).map((c) => c.id)).toEqual(["raw"]);
  });

  // FEAT-002 real-ladder: a card WITH real stored PSA rows shows exactly those
  // PSA grades (and only them), matching AddCardSheet. chipPrice carrying extra
  // PSA keys must NOT invent grades beyond the stored rows. (The Umbreon
  // swsh7-215 case: real PSA 10 + PSA 9 stored.)
  it("emits exactly the real stored PSA grades, ignoring extra chipPrice PSA keys", () => {
    const groups = buildChips(
      [
        { type: "graded", company: "PSA", grade: "10", priceMarket: 1200 },
        { type: "graded", company: "PSA", grade: "9", priceMarket: 700 },
        { type: "raw", condition: "NM", priceMarket: 300 },
      ],
      { raw: 300, "PSA|10": 1200, "PSA|9": 700, "PSA|8": 500 }
    );
    expect(groups.map((g) => g.group)).toEqual(["Raw", "PSA"]);
    const psa = groups.find((g) => g.group === "PSA")!;
    // exactly the two stored grades (desc), NOT the fabricated PSA|8 chipPrice key
    expect(psa.chips.map((c) => c.grade)).toEqual(["10", "9"]);
    expect(psa.chips.map((c) => c.price)).toEqual([1200, 700]);
  });

  it("ignores graded rows missing company or grade (no fabricated chip)", () => {
    const groups = buildChips(
      [
        { type: "graded", company: "PSA", grade: "", priceMarket: 1 },
        { type: "graded", company: "", grade: "10", priceMarket: 1 },
      ],
      { raw: 1 }
    );
    expect(groups.map((g) => g.group)).toEqual(["Raw"]);
  });

  it("colors graded chips from the shared palette by global graded index", () => {
    const groups = buildChips(
      [
        { type: "graded", company: "PSA", grade: "10", priceMarket: 1 },
        { type: "graded", company: "PSA", grade: "9", priceMarket: 1 },
        { type: "graded", company: "BGS", grade: "9.5", priceMarket: 1 },
      ],
      { raw: 1 }
    );
    const graded = groups.filter((g) => g.group !== "Raw").flatMap((g) => g.chips);
    // palette = [gold, jade, verm, gold, #D400FF, #2D7FF9]
    expect(graded.map((c) => c.color)).toEqual([GOLD, JADE, VERM]);
  });
});

describe("buildChartMatrix", () => {
  const chip = (over: Partial<Chip>): Chip => ({
    id: "raw",
    group: "Raw",
    grade: "Raw",
    company: null,
    price: 10,
    color: "#9AA0A6",
    ...over,
  });

  it("plots the raw chip's own stored history as a real varying series", () => {
    const history: HistoryResponse = {
      raw: [
        { date: "2025-01-01", price: 10 },
        { date: "2025-02-01", price: 20 },
        { date: "2025-03-01", price: 15 },
      ],
      graded: {},
    };
    const { data, series } = buildChartMatrix({
      activeChips: [chip({})],
      history,
      chipPrice: { raw: 15 },
      rangeDays: Infinity,
    });
    expect(series).toEqual([{ valueKey: "raw", label: "Raw", color: "#9AA0A6" }]);
    expect(data.map((d) => d.raw)).toEqual([10, 20, 15]);
    // no NaN/undefined anywhere
    for (const d of data) expect(typeof d.raw).toBe("number");
  });

  it("plots a PSA 10 chip's graded history DISTINCT from the raw series", () => {
    const history: HistoryResponse = {
      raw: [
        { date: "2025-01-01", price: 10 },
        { date: "2025-02-01", price: 12 },
      ],
      graded: {
        "PSA|10": [
          { date: "2025-01-01", price: 1000 },
          { date: "2025-02-01", price: 1100 },
        ],
      },
    };
    const psa10 = chip({ id: "PSA|10", group: "PSA", grade: "10", company: "PSA", price: 1050, color: GOLD });
    const { data, series } = buildChartMatrix({
      activeChips: [chip({}), psa10],
      history,
      chipPrice: { raw: 12, "PSA|10": 1050 },
      rangeDays: Infinity,
    });
    expect(series.map((s) => s.valueKey)).toEqual(["raw", "PSA|10"]);
    const rawVals = data.map((d) => d.raw);
    const psaVals = data.map((d) => d["PSA|10"]);
    expect(rawVals).toEqual([10, 12]);
    expect(psaVals).toEqual([1000, 1100]);
    expect(psaVals).not.toEqual(rawVals); // numerically distinct, not a reused raw shape
  });

  it("gives a chip with no stored history a TWO-ROW flat marker at its current price", () => {
    const history: HistoryResponse = { raw: [], graded: {} };
    const psa10 = chip({ id: "PSA|10", group: "PSA", grade: "10", company: "PSA", price: 900, color: GOLD });
    const { data, series } = buildChartMatrix({
      activeChips: [psa10],
      history,
      chipPrice: { "PSA|10": 900 },
      rangeDays: Infinity,
    });
    expect(series.map((s) => s.valueKey)).toEqual(["PSA|10"]);
    expect(data.length).toBeGreaterThanOrEqual(2); // >=2 rows, never a 1-row series
    expect(data.every((d) => d["PSA|10"] === 900)).toBe(true); // flat at current price, no fabricated trend
  });

  it("builds a dense matrix (every union date has a real number for every series)", () => {
    const history: HistoryResponse = {
      raw: [
        { date: "2025-01-01", price: 10 },
        { date: "2025-03-01", price: 30 },
      ],
      graded: {
        "PSA|10": [
          { date: "2025-02-01", price: 1000 },
          { date: "2025-04-01", price: 1200 },
        ],
      },
    };
    const psa10 = chip({ id: "PSA|10", group: "PSA", grade: "10", company: "PSA", price: 1100, color: GOLD });
    const { data, series } = buildChartMatrix({
      activeChips: [chip({}), psa10],
      history,
      chipPrice: { raw: 30, "PSA|10": 1100 },
      rangeDays: Infinity,
    });
    const keys = series.map((s) => s.valueKey);
    // union of 4 distinct dates
    expect(data.length).toBe(4);
    for (const d of data) {
      for (const k of keys) {
        expect(typeof d[k]).toBe("number");
        expect(Number.isNaN(d[k] as number)).toBe(false);
      }
    }
  });

  it("excludes a chip with <2 real points AND a null current price", () => {
    const history: HistoryResponse = { raw: [{ date: "2025-01-01", price: 10 }, { date: "2025-02-01", price: 12 }], graded: {} };
    const psa10 = chip({ id: "PSA|10", group: "PSA", grade: "10", company: "PSA", price: null, color: GOLD });
    const { series } = buildChartMatrix({
      activeChips: [chip({}), psa10],
      history,
      chipPrice: { raw: 12, "PSA|10": null },
      rangeDays: Infinity,
    });
    expect(series.map((s) => s.valueKey)).toEqual(["raw"]); // PSA|10 excluded
  });

  it("windows each series by rangeDays from its OWN newest point", () => {
    const history: HistoryResponse = {
      raw: [
        { date: "2024-01-01", price: 5 },
        { date: "2025-02-15", price: 10 },
        { date: "2025-03-01", price: 20 },
      ],
      graded: {},
    };
    const { data } = buildChartMatrix({
      activeChips: [chip({})],
      history,
      chipPrice: { raw: 20 },
      rangeDays: 31, // ~1M back from 2025-03-01 -> drops 2024-01-01
    });
    expect(data.map((d) => d.raw)).toEqual([10, 20]);
  });

  it("returns an HONEST EMPTY matrix when all chips are excluded (no fake $1 baseline)", () => {
    // audit 04 F-04 (RULE 2): the old all-excluded branch returned
    // [{value:1},{value:1}] — a fabricated jade "rising" area at a fake $1 with a
    // misleading "$1.00 … $0.00" Y axis. It must now be EMPTY so the page renders
    // an honest empty state. This FAILS if the fake baseline ever returns.
    const history: HistoryResponse = { raw: [], graded: {} };
    const raw = chip({ price: null });
    const { data, series } = buildChartMatrix({
      activeChips: [raw],
      history,
      chipPrice: { raw: null },
      rangeDays: Infinity,
    });
    expect(series).toEqual([]);
    expect(data).toEqual([]);
    // the fabricated $1 baseline must be gone
    expect(data.some((d) => d.value === 1)).toBe(false);
  });

  it("returns an empty matrix when NO chips are selected at all (every chip deselected)", () => {
    const history: HistoryResponse = {
      raw: [
        { date: "2026-01-01", price: 10 },
        { date: "2026-02-01", price: 20 },
      ],
      graded: {},
    };
    // activeChips empty → the user deselected every series → honest empty, not $1.
    const { data, series } = buildChartMatrix({
      activeChips: [],
      history,
      chipPrice: { raw: 20 },
      rangeDays: Infinity,
    });
    expect(series).toEqual([]);
    expect(data).toEqual([]);
  });

  it("threads the range into the datum labels (1M → day-level, 3M → month)", () => {
    const history: HistoryResponse = {
      raw: [
        { date: "2026-06-01", price: 10 },
        { date: "2026-06-20", price: 12 },
      ],
      graded: {},
    };
    const oneM = buildChartMatrix({ activeChips: [chip({})], history, chipPrice: { raw: 12 }, rangeDays: Infinity, range: "1M" });
    // 1M labels carry a day number, no year.
    expect(String(oneM.data[0].label)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    const threeM = buildChartMatrix({ activeChips: [chip({})], history, chipPrice: { raw: 12 }, rangeDays: Infinity, range: "3M" });
    // 3M labels are month-only, no digits.
    expect(String(threeM.data[0].label)).toMatch(/^[A-Z][a-z]{2}$/);
  });
});

describe("fmtChartDate (range-aware x-axis labels)", () => {
  it("1M → day-level 'Jun 12' (no year)", () => {
    expect(fmtChartDate("2026-06-12", "1M")).toBe("Jun 12");
  });

  it("3M → month-only 'Jun' (no digits)", () => {
    const label = fmtChartDate("2026-06-12", "3M");
    expect(label).toBe("Jun");
    expect(label).not.toMatch(/\d/);
  });

  it("1Y / default → month + 4-digit year", () => {
    expect(fmtChartDate("2026-06-12", "1Y")).toMatch(/\b\d{4}\b/);
    expect(fmtChartDate("2026-06-12")).toBe("Jun 2026");
  });

  it("returns '' for a synthetic flat-marker key (never surfaces flat-0)", () => {
    expect(fmtChartDate("flat-0", "1M")).toBe("");
    expect(fmtChartDate("flat-1")).toBe("");
  });
});

describe("rangeAvailability / seriesSpanDays (honest range tabs)", () => {
  it("1M is always enabled; longer ranges need span beyond the previous window", () => {
    const a = (d: number) => rangeAvailability(d);
    expect(a(0)).toEqual({ "1M": true, "3M": false, "6M": false, "1Y": false, ALL: false });
    expect(a(10)).toEqual({ "1M": true, "3M": false, "6M": false, "1Y": false, ALL: false });
    expect(a(40)).toEqual({ "1M": true, "3M": true, "6M": false, "1Y": false, ALL: false });
    expect(a(100)).toEqual({ "1M": true, "3M": true, "6M": true, "1Y": false, ALL: false });
    expect(a(200)).toEqual({ "1M": true, "3M": true, "6M": true, "1Y": true, ALL: false });
    expect(a(400)).toEqual({ "1M": true, "3M": true, "6M": true, "1Y": true, ALL: true });
  });

  it("seriesSpanDays = newest - oldest in days (0 for <2 points)", () => {
    expect(seriesSpanDays([])).toBe(0);
    expect(seriesSpanDays([{ date: "2026-01-01", price: 1 }])).toBe(0);
    expect(
      seriesSpanDays([
        { date: "2026-01-01", price: 1 },
        { date: "2026-04-11", price: 2 },
      ])
    ).toBe(100);
  });

  it("100-day fixture: 1M differs from 3M, but 6M/1Y/ALL are identical and reported disabled", () => {
    const raw = Array.from({ length: 11 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 0, 1) + i * 10 * 86_400_000).toISOString().slice(0, 10),
      price: 10 + i,
    }));
    const history: HistoryResponse = { raw, graded: {} };
    const chip: Chip = { id: "raw", group: "Raw", grade: "Raw", company: null, price: 20, color: "#9AA0A6" };
    const at = (rangeDays: number) =>
      buildChartMatrix({ activeChips: [chip], history, chipPrice: { raw: 20 }, rangeDays }).data.map((d) => d.raw);
    expect(at(31)).not.toEqual(at(93));
    expect(at(183)).toEqual(at(366));
    expect(at(366)).toEqual(at(Infinity));
    expect(at(183).length).toBeGreaterThanOrEqual(at(93).length);
    const avail = rangeAvailability(seriesSpanDays(raw));
    expect(seriesSpanDays(raw)).toBe(100);
    expect(avail["3M"]).toBe(true);
    // 100d > 93d so 6M reveals the few extra points; 1Y/ALL reveal nothing and are disabled.
    expect(avail["1Y"]).toBe(false);
    expect(avail.ALL).toBe(false);
  });
});

describe("BUG 5 & 6 — availability/default follow the CARD's data, not the selected chip", () => {
  // Helper: build a daily-ish series spanning `days` from a fixed base.
  const span = (days: number, price = 10): HistoryResponse["raw"] => [
    { date: new Date(Date.UTC(2026, 0, 1)).toISOString().slice(0, 10), price },
    { date: new Date(Date.UTC(2026, 0, 1) + days * 86_400_000).toISOString().slice(0, 10), price: price + 1 },
  ];

  it("maxAvailableSpanDays ignores selection: a 100-day raw series + a sparse graded series → >= 100", () => {
    const history: HistoryResponse = {
      raw: span(100),
      graded: { "PSA|10": [{ date: "2026-02-01", price: 1000 }] }, // 1 point → span 0
    };
    expect(maxAvailableSpanDays(history)).toBe(100);
  });

  it("a sparse graded chip being selected does NOT collapse availability: 1M AND 3M (and 6M) enabled", () => {
    const history: HistoryResponse = {
      raw: span(100),
      graded: { "PSA|10": [{ date: "2026-02-01", price: 1000 }] },
    };
    // Availability derives from the CARD's max span, regardless of which chip
    // (even the sparse graded one) is "selected".
    const avail = rangeAvailability(maxAvailableSpanDays(history));
    expect(avail["1M"]).toBe(true);
    expect(avail["3M"]).toBe(true); // 100 > 31
    expect(avail["6M"]).toBe(true); // 100 > 93
    expect(avail["1Y"]).toBe(false); // 100 <= 183
    expect(avail.ALL).toBe(false);
  });

  it("default range opens on the largest enabled range for a 100-day card (6M)", () => {
    const history: HistoryResponse = { raw: span(100), graded: {} };
    const avail = rangeAvailability(maxAvailableSpanDays(history));
    expect(largestEnabledRange(avail)).toBe("6M");
  });

  it("a card with only a short (<31-day) series enables ONLY 1M; default stays 1M", () => {
    const history: HistoryResponse = { raw: span(10), graded: {} };
    const avail = rangeAvailability(maxAvailableSpanDays(history));
    expect(avail).toEqual({ "1M": true, "3M": false, "6M": false, "1Y": false, ALL: false });
    expect(largestEnabledRange(avail)).toBe("1M");
  });

  it("no history (undefined / empty) → span 0, only 1M, default 1M", () => {
    expect(maxAvailableSpanDays(undefined)).toBe(0);
    expect(maxAvailableSpanDays({ raw: [], graded: {} })).toBe(0);
    expect(largestEnabledRange(rangeAvailability(0))).toBe("1M");
  });

  it("the longest span may come from a GRADED series the raw lacks", () => {
    const history: HistoryResponse = {
      raw: span(10),
      graded: { "PSA|10": span(200, 1000) },
    };
    expect(maxAvailableSpanDays(history)).toBe(200);
    expect(largestEnabledRange(rangeAvailability(200))).toBe("1Y"); // 200 > 183, <= 366
  });
});

describe("buildChips with rows of ONE variant", () => {
  it("does not mix another variant\x27s graded rows", () => {
    const rows = [
      { variant: "unlimitedHolofoil", type: "graded", company: "PSA", grade: "10", priceMarket: 29981 },
      { variant: "firstEditionHolofoil", type: "graded", company: "PSA", grade: "10", priceMarket: 83435 },
    ];
    const one = rows.filter((r) => r.variant === "unlimitedHolofoil");
    const psa = buildChips(one, { raw: 782.55 }).find((g) => g.group === "PSA")!;
    expect(psa.chips.map((c) => c.price)).toEqual([29981]);
  });
});
