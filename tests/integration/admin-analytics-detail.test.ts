import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Admin DETAIL analytics (admin-metrics.ts) against a MOCKED Prisma client.
 *
 * Pins the data layer FEAT-001 adds for the richer admin analytics panel:
 *   - getScanUsageSeries   — per-day scan counts (success/fail split), gap-filled,
 *                            estimated Vision credits = successful vision scans * 5
 *   - getPortfolioTotals   — isSold=false value + owned-qty, avg collection size
 *                            with a 0-users guard
 *   - getPerGameSplit      — POKEMON vs ONE_PIECE owned-qty, isSold=false
 *   - getActiveUsers       — distinct Session.userId updatedAt>=now-1d / now-7d
 *   - getTopWantedCards    — grouped want_list_item desc, honest [] empty
 *   - getMostScannedCards  — grouped scan_feedback picked desc, honest [] empty
 *
 * $queryRaw doesn't run real SQL here, so the financial/game tests also assert the
 * SQL TEMPLATE carries uc."isSold" = false (via sqlTextOf), matching the pattern in
 * admin-metrics-financials.test.ts. No live DB/network (AGENTS.md testing map).
 */

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  user: { count: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import {
  getScanUsageSeries,
  getPortfolioTotals,
  getPerGameSplit,
  getActiveUsers,
  getTopWantedCards,
  getMostScannedCards,
} from "@/lib/services/admin-metrics";

// Join the tagged-template static fragments back into raw SQL text so we can
// assert a predicate is literally present (same helper as the financials test).
function sqlTextOf(callArgs: unknown[]): string {
  const strings = callArgs[0] as readonly string[];
  return strings.join(" ");
}

// A UTC day Date for `n` days ago (midnight), so rows land inside the live range.
function daysAgoUtc(n: number): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getScanUsageSeries", () => {
  it("gap-fills per-day totals, splits success/fail, estimates Vision credits", async () => {
    const twoDaysAgo = daysAgoUtc(2);
    const today = daysAgoUtc(0);
    // grouped scan rows: total, success (picked not null), visionSuccess
    prismaMock.$queryRaw.mockResolvedValueOnce([
      { day: twoDaysAgo, total: 4n, success: 3n, visionSuccess: 2n },
      { day: today, total: 2n, success: 1n, visionSuccess: 1n },
    ]);

    const res = await getScanUsageSeries();

    const k2 = twoDaysAgo.toISOString().slice(0, 10);
    const kToday = today.toISOString().slice(0, 10);
    const p2 = res.points.find((p) => p.date === k2)!;
    const pt = res.points.find((p) => p.date === kToday)!;
    expect(p2.success).toBe(3);
    expect(p2.fail).toBe(1); // total 4 − success 3
    expect(pt.success).toBe(1);
    expect(pt.fail).toBe(1); // total 2 − success 1

    // Every other in-range day is a true 0 (gap fill), not fabricated.
    const nonZero = res.points.filter((p) => p.success + p.fail > 0);
    expect(nonZero).toHaveLength(2);

    // Totals + credit estimate: (2 + 1) successful vision scans * 5 = 15.
    expect(res.totalScans).toBe(6);
    expect(res.successfulScans).toBe(4);
    expect(res.failedScans).toBe(2);
    expect(res.estimatedVisionCredits).toBe(15);
  });

  it("honest empty: no rows → flat-zero series and zero totals/credits", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([]);
    const res = await getScanUsageSeries();
    expect(res.points.every((p) => p.success === 0 && p.fail === 0)).toBe(true);
    expect(res.totalScans).toBe(0);
    expect(res.successfulScans).toBe(0);
    expect(res.failedScans).toBe(0);
    expect(res.estimatedVisionCredits).toBe(0);
  });
});

describe("getPortfolioTotals", () => {
  it("value/active-qty SQL carries isSold=false and avg = activeCards/totalUsers", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ total: 120 }]) // portfolio value (filtered)
      .mockResolvedValueOnce([{ total: 40 }]); // active cards qty (filtered)
    prismaMock.user.count.mockResolvedValueOnce(4);

    const t = await getPortfolioTotals();

    expect(t.totalPortfolioValue).toBe(120);
    expect(t.activeCards).toBe(40);
    expect(t.totalUsers).toBe(4);
    expect(t.averageCollectionSize).toBe(10); // 40 / 4

    const valueSql = sqlTextOf(prismaMock.$queryRaw.mock.calls[0]);
    const qtySql = sqlTextOf(prismaMock.$queryRaw.mock.calls[1]);
    expect(valueSql).toMatch(/uc\."isSold"\s*=\s*false/);
    expect(qtySql).toMatch(/uc\."isSold"\s*=\s*false/);
  });

  it("guards divide-by-zero: 0 users → averageCollectionSize 0", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([{ total: 0 }]);
    prismaMock.user.count.mockResolvedValueOnce(0);

    const t = await getPortfolioTotals();
    expect(t.averageCollectionSize).toBe(0);
  });
});

describe("getPerGameSplit", () => {
  it("maps POKEMON/ONE_PIECE owned-qty sums and filters isSold=false", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([
      { game: "POKEMON", total: 30n },
      { game: "ONE_PIECE", total: 12n },
    ]);

    const split = await getPerGameSplit();
    expect(split.pokemon).toBe(30);
    expect(split.onePiece).toBe(12);

    const sql = sqlTextOf(prismaMock.$queryRaw.mock.calls[0]);
    expect(sql).toMatch(/uc\."isSold"\s*=\s*false/);
  });

  it("honest empty: a game with no owned rows is a true 0", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ game: "POKEMON", total: 5n }]);
    const split = await getPerGameSplit();
    expect(split.pokemon).toBe(5);
    expect(split.onePiece).toBe(0);
  });
});

describe("getActiveUsers", () => {
  it("returns distinct-session DAU/WAU from the two COUNT(DISTINCT userId) rows", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ count: 3n }]) // dau
      .mockResolvedValueOnce([{ count: 11n }]); // wau

    const { dau, wau } = await getActiveUsers();
    expect(dau).toBe(3);
    expect(wau).toBe(11);

    const dauSql = sqlTextOf(prismaMock.$queryRaw.mock.calls[0]);
    expect(dauSql).toMatch(/COUNT\(DISTINCT\s*"userId"\)/i);
  });

  it("honest empty: no recent sessions → 0/0", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ count: 0n }])
      .mockResolvedValueOnce([{ count: 0n }]);
    const { dau, wau } = await getActiveUsers();
    expect(dau).toBe(0);
    expect(wau).toBe(0);
  });
});

describe("getTopWantedCards", () => {
  it("maps name + count preserving SQL desc order", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([
      { cardId: "base1-4", name: "Charizard", total: 9n },
      { cardId: "OP01-064", name: "Luffy", total: 4n },
    ]);
    const top = await getTopWantedCards(10);
    expect(top).toEqual([
      { cardId: "base1-4", name: "Charizard", count: 9 },
      { cardId: "OP01-064", name: "Luffy", count: 4 },
    ]);
    const counts = top.map((t) => t.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it("returns [] when nothing is wanted", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([]);
    expect(await getTopWantedCards()).toEqual([]);
  });

  it("keeps an uncatalogued externalId with a null name (LEFT JOIN honesty)", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([
      { cardId: "ghost-999", name: null, total: 2n },
    ]);
    const top = await getTopWantedCards();
    expect(top).toEqual([{ cardId: "ghost-999", name: null, count: 2 }]);
  });
});

describe("getMostScannedCards", () => {
  it("maps name + count preserving SQL desc order", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([
      { cardId: "base1-4", name: "Charizard", total: 7n },
      { cardId: "base1-58", name: "Pikachu", total: 2n },
    ]);
    const top = await getMostScannedCards(10);
    expect(top).toEqual([
      { cardId: "base1-4", name: "Charizard", count: 7 },
      { cardId: "base1-58", name: "Pikachu", count: 2 },
    ]);
  });

  it("returns [] when nothing has been scanned-and-picked", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([]);
    expect(await getMostScannedCards()).toEqual([]);
  });
});
