import { describe, it, expect } from "vitest";
// Pure helper for the dashboard headline overall change — must be a REAL
// (last − first)/first value from the drawn chart series, with an honest null
// when there isn't enough history (AGENTS.md RULE 2: never fabricate).
import { computeOverallChange, type ValueSeries } from "@/lib/utils/overall-change";

describe("computeOverallChange — real series", () => {
  it("(a) ≥2 real points → delta/pct = (last − first)/first", () => {
    const series: ValueSeries[] = [{ data: [{ value: 100 }, { value: 110 }, { value: 150 }] }];
    const { delta, pct } = computeOverallChange(series);
    expect(delta).toBe(50); // 150 − 100
    expect(pct).toBeCloseTo(50, 6); // 50 / 100 * 100
  });

  it("aggregates multiple collections per aligned x position", () => {
    const series: ValueSeries[] = [
      { data: [{ value: 100 }, { value: 120 }] }, // +20
      { data: [{ value: 50 }, { value: 40 }] }, //  −10
    ];
    const { delta, pct } = computeOverallChange(series);
    // first 150, last 160 → +10 on 150
    expect(delta).toBe(10);
    expect(pct).toBeCloseTo((10 / 150) * 100, 6);
  });

  it("handles a negative overall change", () => {
    const series: ValueSeries[] = [{ data: [{ value: 200 }, { value: 150 }] }];
    const { delta, pct } = computeOverallChange(series);
    expect(delta).toBe(-50);
    expect(pct).toBeCloseTo(-25, 6);
  });
});

describe("computeOverallChange — honest null (insufficient history)", () => {
  it("(b) <2 real points → null (not 0, not fabricated)", () => {
    expect(computeOverallChange([{ data: [{ value: 100 }] }])).toEqual({ delta: null, pct: null });
    expect(computeOverallChange([{ data: [] }])).toEqual({ delta: null, pct: null });
    expect(computeOverallChange([])).toEqual({ delta: null, pct: null });
  });

  it("(c) first value 0 → null pct (no divide-by-zero)", () => {
    const { delta, pct } = computeOverallChange([{ data: [{ value: 0 }, { value: 25 }] }]);
    expect(delta).toBe(25);
    expect(pct).toBeNull();
  });
});
