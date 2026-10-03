import { describe, it, expect } from "vitest";
import {
  allocateBasis,
  realizedPnL,
  unrealizedPnL,
  aggregatePortfolio,
} from "@/lib/utils/portfolio-accounting";

/**
 * Portfolio accounting math (plan §5). Pins the HONESTY rules: unresolved basis
 * is never 0, realized = proceeds − allocated basis (no fees), and partial
 * sales allocate basis proportionally so splits conserve total basis.
 */
describe("allocateBasis (proportional, conserves total)", () => {
  it("allocates per-copy basis across a sold quantity", () => {
    expect(allocateBasis(10, 3)).toBe(30);
  });
  it("splitting a 5-copy lot (basis 10/copy) across partial sales sums to 50", () => {
    expect(allocateBasis(10, 2)! + allocateBasis(10, 3)!).toBe(50);
  });
  it("null per-copy basis stays unresolved (null), never 0", () => {
    expect(allocateBasis(null, 4)).toBeNull();
  });
});

describe("realizedPnL (proceeds − basis, no fees)", () => {
  it("resolved: gross 95×2 − basis 40×2 = 110", () => {
    expect(realizedPnL(2, 95, 40)).toEqual({ status: "resolved", value: 110 });
  });
  it("unresolved basis → unresolved (never a number)", () => {
    expect(realizedPnL(2, 95, null)).toEqual({ status: "unresolved" });
  });
});

describe("unrealizedPnL", () => {
  it("resolved: (market 50 − basis 30) × 4 = 80", () => {
    expect(unrealizedPnL(4, 50, 30)).toEqual({ status: "resolved", value: 80 });
  });
  it("unresolved when market OR basis is null", () => {
    expect(unrealizedPnL(4, null, 30)).toEqual({ status: "unresolved" });
    expect(unrealizedPnL(4, 50, null)).toEqual({ status: "unresolved" });
  });
});

describe("aggregatePortfolio", () => {
  it("keeps unresolved lots out of the sums and counts them", () => {
    const stats = aggregatePortfolio(
      [
        { qty: 2, marketPerCopy: 50, basisPerCopy: 30 }, // mv 100, paid 60, unreal 40
        { qty: 1, marketPerCopy: 20, basisPerCopy: null }, // unresolved basis
      ],
      [
        { qty: 1, grossPerCopy: 80, basisPerCopy: 30 }, // realized 50
        { qty: 1, grossPerCopy: 80, basisPerCopy: null }, // unresolved
      ]
    );
    expect(stats.marketValue).toBe(120); // 100 + 20 (market known even if basis isn't)
    expect(stats.paid).toBe(60); // only the resolved lot
    expect(stats.realized).toBe(50);
    expect(stats.unrealized).toBe(40); // only the lot with both resolved
    expect(stats.unresolvedCount).toBe(2); // 1 active + 1 sold
  });
});
