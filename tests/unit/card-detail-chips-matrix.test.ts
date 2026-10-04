import { describe, it, expect } from "vitest";
import {
  buildChips,
  buildChartMatrix,
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

  it("falls back to an honest flat baseline when all chips are excluded", () => {
    const history: HistoryResponse = { raw: [], graded: {} };
    const raw = chip({ price: null });
    const { data, series } = buildChartMatrix({
      activeChips: [raw],
      history,
      chipPrice: { raw: null },
      rangeDays: Infinity,
    });
    // single-series flat baseline, no fabricated prices
    expect(series.length).toBeLessThanOrEqual(1);
    expect(data.length).toBe(2);
    expect(data.every((d) => d.value === 1)).toBe(true);
  });
});
