import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Admin time-series analytics (admin-metrics.ts) against a MOCKED Prisma client.
 * Pins the series SHAPE and the real aggregation logic:
 *   - user growth is a gap-filled CUMULATIVE curve seeded by the pre-range baseline
 *   - cards-added is a gap-filled per-day series
 *   - top-collected is sorted by summed quantity DESC and maps card.name
 * No live DB/network (AGENTS.md testing map).
 */

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  user: { count: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import {
  getUserGrowthSeries,
  getCardsAddedSeries,
  getTopCollectedCards,
} from "@/lib/services/admin-metrics";

beforeEach(() => {
  vi.clearAllMocks();
});

// A UTC day Date for `n` days ago (midnight), so rows land inside the live range.
function daysAgoUtc(n: number): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

describe("getUserGrowthSeries", () => {
  it("returns a gap-free cumulative curve seeded by the pre-range baseline", async () => {
    const twoDaysAgo = daysAgoUtc(2);
    const today = daysAgoUtc(0);
    // $queryRaw → grouped new-users-per-day; user.count → baseline before range.
    prismaMock.$queryRaw.mockResolvedValueOnce([
      { day: twoDaysAgo, count: 2n },
      { day: today, count: 3n },
    ]);
    prismaMock.user.count.mockResolvedValueOnce(10); // 10 users before the window

    const { points } = await getUserGrowthSeries();

    // Cumulative + baseline: never decreases, ends at baseline + all in-range adds.
    expect(points.length).toBeGreaterThan(0);
    for (let i = 1; i < points.length; i++) {
      expect(points[i].count).toBeGreaterThanOrEqual(points[i - 1].count);
    }
    expect(points[0].count).toBe(10); // starts at baseline (day -89 had 0 new)
    expect(points[points.length - 1].count).toBe(15); // 10 + 2 + 3
  });

  it("honest empty-signal: baseline 0 and no rows → flat-zero curve", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([]);
    prismaMock.user.count.mockResolvedValueOnce(0);

    const { points } = await getUserGrowthSeries();
    expect(points.every((p) => p.count === 0)).toBe(true);
  });
});

describe("getCardsAddedSeries", () => {
  it("returns a gap-filled per-day series with the real counts in place", async () => {
    const oneDayAgo = daysAgoUtc(1);
    prismaMock.$queryRaw.mockResolvedValueOnce([{ day: oneDayAgo, count: 7n }]);

    const { points } = await getCardsAddedSeries();
    const key = oneDayAgo.toISOString().slice(0, 10);
    expect(points.find((p) => p.date === key)?.count).toBe(7);
    // Every other in-range day is a true 0 (gap fill), not fabricated.
    expect(points.filter((p) => p.count === 7)).toHaveLength(1);
    expect(points.every((p) => p.count === 0 || p.count === 7)).toBe(true);
  });
});

describe("getTopCollectedCards", () => {
  it("maps card name + summed quantity and preserves the SQL desc order", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([
      { cardId: "c1", name: "Charizard", total: 42n },
      { cardId: "c2", name: "Pikachu", total: 19n },
      { cardId: "c3", name: "Mew", total: 5n },
    ]);

    const top = await getTopCollectedCards(10);
    expect(top).toEqual([
      { cardId: "c1", name: "Charizard", totalQuantity: 42 },
      { cardId: "c2", name: "Pikachu", totalQuantity: 19 },
      { cardId: "c3", name: "Mew", totalQuantity: 5 },
    ]);
    // Sorted by summed quantity desc (asserted independently of input order).
    const qtys = top.map((t) => t.totalQuantity);
    expect([...qtys].sort((a, b) => b - a)).toEqual(qtys);
  });

  it("returns [] when nothing is collected", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([]);
    expect(await getTopCollectedCards()).toEqual([]);
  });
});
