import { describe, it, expect } from "vitest";
import {
  orderByForCardSort,
  CARD_SORT_LABELS,
  sortByWeeklyChange,
  WEEK_SORT_KEYS,
} from "@/lib/utils/card-sort";

/**
 * Unit test for the shared card sort mapping. Trivial-but-real: if the
 * orderBy shape for a sort key ever changes, this fails — the smallest
 * check that proves the unit runner + path aliases work.
 */
describe("orderByForCardSort", () => {
  it("maps name_asc to a single name-ascending clause", () => {
    expect(orderByForCardSort("name_asc")).toEqual([{ name: "asc" }]);
  });

  it("defaults market_desc to price-desc then name", () => {
    expect(orderByForCardSort("market_desc")).toEqual([
      { marketPrice: { sort: "desc", nulls: "last" } },
      { name: "asc" },
    ]);
  });

  it("has a label for every sort key", () => {
    for (const key of ["trending", "market_desc", "market_asc", "name_asc", "recent"] as const) {
      expect(CARD_SORT_LABELS[key]).toBeTruthy();
    }
  });
});

type Row = { id: string; abs?: number | null; pct?: number | null; ok?: boolean };
const pick = (r: Row) => ({ weeklyChangeAbs: r.abs, weeklyChangePct: r.pct });
const ids = (rs: Row[]) => rs.map((r) => r.id);

describe("sortByWeeklyChange (FEAT-003)", () => {
  const rows: Row[] = [
    { id: "a", abs: -2, pct: -5 },
    { id: "b", abs: 3, pct: 1 },
    { id: "c", abs: null, pct: null },
    { id: "d", abs: 0, pct: 0 },
  ];
  it("sorts negatives and positives desc/asc with null last", () => {
    expect(ids(sortByWeeklyChange(rows, "week_change_desc", pick))).toEqual(["b", "d", "a", "c"]);
    expect(ids(sortByWeeklyChange(rows, "week_change_asc", pick))).toEqual(["a", "d", "b", "c"]);
  });
  it("uses pct for pct keys", () => {
    expect(ids(sortByWeeklyChange(rows, "week_pct_desc", pick))).toEqual(["b", "d", "a", "c"]);
    expect(ids(sortByWeeklyChange(rows, "week_pct_asc", pick))).toEqual(["a", "d", "b", "c"]);
  });
  it("treats missing, NaN and Infinity (zero baseline) as null-last", () => {
    const r: Row[] = [
      { id: "nan", pct: NaN },
      { id: "inf", pct: Infinity },
      { id: "undef" },
      { id: "ok", pct: 1 },
    ];
    expect(ids(sortByWeeklyChange(r, "week_pct_desc", pick))).toEqual(["ok", "nan", "inf", "undef"]);
    expect(ids(sortByWeeklyChange(r, "week_pct_asc", pick))).toEqual(["ok", "nan", "inf", "undef"]);
  });
  it("sends unusable (stale) rows last via isUsable", () => {
    const r: Row[] = [
      { id: "stale", abs: 99, ok: false },
      { id: "fresh", abs: 1, ok: true },
    ];
    expect(ids(sortByWeeklyChange(r, "week_change_desc", pick, (x) => x.ok !== false))).toEqual(["fresh", "stale"]);
  });
  it("is stable for ties and nulls, and does not mutate input", () => {
    const r: Row[] = [
      { id: "n1" }, { id: "t1", abs: 2 }, { id: "n2" }, { id: "t2", abs: 2 }, { id: "t3", abs: 2 },
    ];
    const copy = [...r];
    expect(ids(sortByWeeklyChange(r, "week_change_desc", pick))).toEqual(["t1", "t2", "t3", "n1", "n2"]);
    expect(ids(sortByWeeklyChange(r, "week_change_asc", pick))).toEqual(["t1", "t2", "t3", "n1", "n2"]);
    expect(r).toEqual(copy);
  });
  it("exposes the four week keys", () => {
    expect([...WEEK_SORT_KEYS].sort()).toEqual(
      ["week_change_asc", "week_change_desc", "week_pct_asc", "week_pct_desc"]
    );
  });
  it("labels read 7-day change ($)/(%)", () => {
    expect(CARD_SORT_LABELS.week_change_desc).toMatch(/^7-day change \(\$\)/);
    expect(CARD_SORT_LABELS.week_change_asc).toMatch(/^7-day change \(\$\)/);
    expect(CARD_SORT_LABELS.week_pct_desc).toMatch(/^7-day change \(%\)/);
    expect(CARD_SORT_LABELS.week_pct_asc).toMatch(/^7-day change \(%\)/);
  });
});