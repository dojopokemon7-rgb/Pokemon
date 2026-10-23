import { describe, it, expect } from "vitest";
import {
  buildDashboardMatrix,
  dashboardOverallChange,
  hasDashboardHistory,
  scopeSeriesToFocus,
  type DashboardSeries,
} from "@/lib/utils/dashboard-chart";

/**
 * audit 04 F-03 (RULE 2 — never fabricate): the dashboard comparison chart used
 * to right-align per-collection series by INDEX and back-fill a shorter series'
 * first real value LEFTWARD — drawing a value for dates BEFORE the collection
 * was owned/priced. These checks pin the honest replacement: series align by
 * DATE and each one is an honest GAP (NaN) on dates before its FIRST real point.
 * They FAIL if the leftward back-fill ever returns.
 */

const s = (
  id: string,
  points: { date: string; value: number | null }[],
  name = id,
  color = "#000"
): DashboardSeries => ({ id, name, color, points });

describe("buildDashboardMatrix — honest leading gaps (no leftward back-fill)", () => {
  it("a later-started series is NaN on dates before its first real point, never back-filled", () => {
    // A: real on all 3 dates. B: owned from day-02 only (null gap on day-01).
    const matrix = buildDashboardMatrix([
      s("A", [
        { date: "2026-01-01", value: 100 },
        { date: "2026-01-02", value: 110 },
        { date: "2026-01-03", value: 120 },
      ]),
      s("B", [
        { date: "2026-01-01", value: null }, // honest gap — not owned yet
        { date: "2026-01-02", value: 50 },
        { date: "2026-01-03", value: 60 },
      ]),
    ]);
    expect(matrix.data.map((d) => d.A)).toEqual([100, 110, 120]);
    // B's first real point is day-02 → day-01 is an HONEST GAP (NaN), NOT 50.
    expect(Number.isNaN(matrix.data[0].B as number)).toBe(true);
    expect(matrix.data[0].B).not.toBe(50); // the old back-fill lie
    expect(matrix.data.slice(1).map((d) => d.B)).toEqual([50, 60]);
  });

  it("carries a series' own real value forward after its first real point (real shape preserved)", () => {
    const matrix = buildDashboardMatrix([
      s("A", [
        { date: "2026-01-01", value: 10 },
        { date: "2026-01-02", value: 20 },
        { date: "2026-01-03", value: 30 },
      ]),
      s("B", [
        { date: "2026-01-01", value: 5 },
        { date: "2026-01-02", value: null }, // interior gap → carry 5 forward
        { date: "2026-01-03", value: 9 },
      ]),
    ]);
    expect(matrix.data.map((d) => d.B)).toEqual([5, 5, 9]);
  });

  it("drops series with < 2 real points and returns an empty matrix when none are drawable", () => {
    expect(buildDashboardMatrix([]).series).toEqual([]);
    expect(buildDashboardMatrix([s("A", [{ date: "2026-01-01", value: 10 }])]).series).toEqual([]);
    const mixed = buildDashboardMatrix([
      s("A", [{ date: "2026-01-01", value: 10 }]), // 1 real → dropped
      s("B", [
        { date: "2026-01-01", value: 1 },
        { date: "2026-01-02", value: 2 },
      ]),
    ]);
    expect(mixed.series.map((x) => x.valueKey)).toEqual(["B"]);
  });
});

describe("dashboardOverallChange — baseline excludes not-yet-owned series", () => {
  it("first aggregate counts only series present at the first union date (no back-filled baseline)", () => {
    // Day-01 aggregate = A only (100). Day-03 aggregate = A(120)+B(60)=180.
    const change = dashboardOverallChange([
      s("A", [
        { date: "2026-01-01", value: 100 },
        { date: "2026-01-02", value: 110 },
        { date: "2026-01-03", value: 120 },
      ]),
      s("B", [
        { date: "2026-01-01", value: null },
        { date: "2026-01-02", value: 50 },
        { date: "2026-01-03", value: 60 },
      ]),
    ]);
    // Honest: 180 − 100 = 80 on a base of 100. The old back-fill would have made
    // the base 150 (100 + B's 50 drawn at day-01) and the delta 30 — a lie.
    expect(change.delta).toBe(80);
    expect(change.pct).toBeCloseTo(80, 6);
  });

  it("insufficient history → null (never fabricated)", () => {
    expect(dashboardOverallChange([])).toEqual({ delta: null, pct: null });
    expect(dashboardOverallChange([s("A", [{ date: "2026-01-01", value: 10 }])])).toEqual({
      delta: null,
      pct: null,
    });
  });

  it("zero first value → null pct (no divide-by-zero)", () => {
    const change = dashboardOverallChange([
      s("A", [
        { date: "2026-01-01", value: 0 },
        { date: "2026-01-02", value: 25 },
      ]),
    ]);
    expect(change.delta).toBe(25);
    expect(change.pct).toBeNull();
  });
});

describe("scopeSeriesToFocus — chart follows the focused collection (Bug #5)", () => {
  const list = [
    s("A", [
      { date: "2026-01-01", value: 100 },
      { date: "2026-01-02", value: 110 },
    ]),
    s("B", [
      { date: "2026-01-01", value: 10 },
      { date: "2026-01-02", value: 40 },
    ]),
    s("C", [
      { date: "2026-01-01", value: 1 },
      { date: "2026-01-02", value: 2 },
    ]),
  ];

  it("focusedId=null returns all series", () => {
    const scoped = scopeSeriesToFocus(list, null, () => true);
    expect(scoped.map((x) => x.id)).toEqual(["A", "B", "C"]);
  });

  it("focusedId='B' with an active focus returns only series B", () => {
    const scoped = scopeSeriesToFocus(list, "B", (id) => id === "B");
    expect(scoped.map((x) => x.id)).toEqual(["B"]);
  });

  it("an inactive focus is ignored → all series returned", () => {
    const scoped = scopeSeriesToFocus(list, "B", () => false);
    expect(scoped.map((x) => x.id)).toEqual(["A", "B", "C"]);
  });

  it("the scoped single-series result drives its OWN curve, not the combined one", () => {
    const scoped = scopeSeriesToFocus(list, "B", (id) => id === "B");
    // B alone: 10 → 40. Combined would be 111 → 152 (delta 41) — this proves the
    // chart/headline draw the focused collection, not the aggregate.
    const matrix = buildDashboardMatrix(scoped);
    expect(matrix.series.map((x) => x.valueKey)).toEqual(["B"]);
    expect(matrix.data.map((d) => d.B)).toEqual([10, 40]);
    const change = dashboardOverallChange(scoped);
    expect(change.delta).toBe(30);
    expect(change.pct).toBeCloseTo(300, 6);
  });
});

describe("hasDashboardHistory — range-selector gate", () => {
  it("true only when some series has >= 2 real points", () => {
    expect(hasDashboardHistory([])).toBe(false);
    expect(hasDashboardHistory([s("A", [{ date: "2026-01-01", value: 1 }])])).toBe(false);
    expect(
      hasDashboardHistory([
        s("A", [
          { date: "2026-01-01", value: 1 },
          { date: "2026-01-02", value: 2 },
        ]),
      ])
    ).toBe(true);
  });
});
