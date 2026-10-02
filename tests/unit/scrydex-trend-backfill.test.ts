import { describe, it, expect } from "vitest";

/**
 * FR-4 (AC-10, OQ#2) — first-pull trend backfill helper.
 *
 * `buildTrendBackfill` derives up to 3 PRIOR absolute price points from the
 * rolling trend deltas (`price_change` is an absolute USD delta in the
 * verified payload, so prior = market − price_change) at −1/−7/−14d. A
 * missing/null delta skips that point; a resulting <=0 point is dropped
 * (never fabricate). Pure helper — no Prisma. The caller labels these rows
 * source="scrydex-trend".
 */
import { buildTrendBackfill } from "@/lib/services/scrydex-pricing.service";

const NOW = new Date("2026-10-02T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

type Trends = Parameters<typeof buildTrendBackfill>[1];

describe("buildTrendBackfill", () => {
  it("produces exactly the −1/−7/−14d points via market − price_change", () => {
    const trends = {
      days_1: { price_change: -7.33, percent_change: -3.69 },
      days_7: { price_change: 7.39, percent_change: 4.02 },
      days_14: { price_change: 23.85, percent_change: 14.24 },
    } as unknown as Trends;

    const points = buildTrendBackfill(191.34, trends, NOW);

    expect(points).toHaveLength(3);
    // prior = market − delta
    expect(points[0].priceMarket).toBeCloseTo(191.34 - -7.33, 2); // 198.67
    expect(points[1].priceMarket).toBeCloseTo(191.34 - 7.39, 2); // 183.95
    expect(points[2].priceMarket).toBeCloseTo(191.34 - 23.85, 2); // 167.49
    // dated at now − {1,7,14} days
    expect(points[0].recordedAt.getTime()).toBe(NOW.getTime() - 1 * DAY_MS);
    expect(points[1].recordedAt.getTime()).toBe(NOW.getTime() - 7 * DAY_MS);
    expect(points[2].recordedAt.getTime()).toBe(NOW.getTime() - 14 * DAY_MS);
  });

  it("skips null/missing deltas (writes 0–3 points, never fabricates)", () => {
    const trends = {
      days_1: { price_change: 5, percent_change: 2 },
      days_7: { price_change: null, percent_change: null },
      // days_14 absent entirely
    } as unknown as Trends;

    const points = buildTrendBackfill(100, trends, NOW);
    expect(points).toHaveLength(1);
    expect(points[0].priceMarket).toBe(95);
  });

  it("drops a point whose derived prior price would be <= 0", () => {
    const trends = {
      days_1: { price_change: 150, percent_change: 90 }, // prior = 10 - 150 < 0 → dropped
      days_7: { price_change: 2, percent_change: 20 }, // prior = 8 → kept
    } as unknown as Trends;

    const points = buildTrendBackfill(10, trends, NOW);
    expect(points).toHaveLength(1);
    expect(points[0].priceMarket).toBe(8);
  });

  it("returns [] when trends is null", () => {
    expect(buildTrendBackfill(100, null, NOW)).toEqual([]);
  });
});
