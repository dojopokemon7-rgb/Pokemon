import { describe, it, expect } from "vitest";
import { fmtWeeklyDelta } from "@/lib/utils/weekly-delta";

/**
 * fmtWeeklyDelta is the ONE shared null-delta contract (dashboard, trending
 * route, search tiles). It formats a REAL Scrydex 7-day change and NEVER
 * fabricates: a null/undefined pct yields `{ delta: null }` so the caller
 * renders no movement indicator (AGENTS.md rule 2).
 */
describe("fmtWeeklyDelta", () => {
  it("returns a null delta for null/undefined (no fabrication)", () => {
    expect(fmtWeeklyDelta(null)).toEqual({ delta: null, up: true });
    expect(fmtWeeklyDelta(undefined)).toEqual({ delta: null, up: true });
  });

  it("formats a positive change with a + sign and up:true", () => {
    expect(fmtWeeklyDelta(5.2)).toEqual({ delta: "+5.2%", up: true });
  });

  it("formats a negative change with a - sign and up:false", () => {
    expect(fmtWeeklyDelta(-3)).toEqual({ delta: "-3.0%", up: false });
  });

  it("treats exactly 0 as a non-negative change (+0.0%, up:true)", () => {
    expect(fmtWeeklyDelta(0)).toEqual({ delta: "+0.0%", up: true });
  });
});
