import { describe, it, expect } from "vitest";
import { hasAreaTrend } from "@/components/AreaChart";

/**
 * QA #6a: the filled gradient AREA under the line implies a price trend. With
 * only 1-2 real points that shape misleads (two carried-forward near-identical
 * prices draw a straight line but a big swooping fill). hasAreaTrend gates the
 * area: a trend needs >= 3 real points; 1 or 2 points render as an honest bare
 * line/markers with NO fill. No data is hidden or invented — the predicate only
 * decides whether to PAINT the area, not which points exist.
 */
describe("hasAreaTrend (QA #6a — no misleading swoosh)", () => {
  it("treats a single point as NOT a trend (no area fill)", () => {
    expect(hasAreaTrend(1)).toBe(false);
  });

  it("treats two points (even identical) as NOT a trend (no area fill)", () => {
    // Two carried-forward identical prices are exactly the misleading case.
    expect(hasAreaTrend(2)).toBe(false);
  });

  it("draws the area for >= 3 real points (a real trend — dashboard dense history)", () => {
    expect(hasAreaTrend(3)).toBe(true);
    expect(hasAreaTrend(30)).toBe(true);
  });
});
