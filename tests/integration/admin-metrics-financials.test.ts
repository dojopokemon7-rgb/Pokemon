import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Admin FINANCIAL aggregations (admin-metrics.ts) against a MOCKED Prisma client.
 *
 * BUG-3: portfolio value + total invested summed over ALL user_collection rows,
 * including SOLD lots, double-counting a disposed holding as if still held.
 * The fix adds `AND uc."isSold" = false` to the value/invested queries in
 * getUserFinancials, getPlatformStats, and getPortfolioValuesByUser.
 *
 * $queryRaw doesn't execute real SQL here, so each test does two things:
 *   1. Asserts the SQL template carries the isSold = false predicate (the fix is
 *      literally present on the value + invested queries).
 *   2. Feeds back the ALREADY-FILTERED totals from the report's numeric example
 *      (active $10 qty1 + a sold lot → value $12 not $24, invested $10 not $20)
 *      and pins the derived profit/loss arithmetic.
 * No live DB/network (AGENTS.md testing map).
 */

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  user: { count: vi.fn() },
  userCollection: { aggregate: vi.fn(), count: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import { getUserFinancials, getPlatformStats } from "@/lib/services/admin-metrics";

// $queryRaw is a tagged template; the first arg is the TemplateStringsArray of
// the static SQL fragments. Join it back into the raw SQL text so we can assert
// the predicate is present.
function sqlTextOf(callArgs: unknown[]): string {
  const strings = callArgs[0] as readonly string[];
  return strings.join(" ");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getUserFinancials excludes SOLD rows (BUG-3)", () => {
  it("value/invested queries filter isSold = false and P/L uses the filtered totals", async () => {
    // Report's example data AFTER the fix excludes the sold lot:
    //   value   = $12 (active qty1 @ $12), NOT $24 (would include the sold copy)
    //   invested= $10 (active qty1 @ $10), NOT $20
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ total: 12 }]) // portfolio value (filtered)
      .mockResolvedValueOnce([{ total: 10 }]); // total invested (filtered)
    prismaMock.userCollection.aggregate.mockResolvedValueOnce({ _sum: { quantity: 2 } });
    prismaMock.userCollection.count.mockResolvedValueOnce(1); // some purchasePrice recorded

    const fin = await getUserFinancials("user-1");

    expect(fin.portfolioValue).toBe(12);
    expect(fin.totalInvested).toBe(10);
    expect(fin.profitLoss).toBe(2); // 12 − 10, not 24 − 20

    // Both the value and the invested SQL templates carry the exclusion.
    const valueSql = sqlTextOf(prismaMock.$queryRaw.mock.calls[0]);
    const investedSql = sqlTextOf(prismaMock.$queryRaw.mock.calls[1]);
    expect(valueSql).toMatch(/uc\."isSold"\s*=\s*false/);
    expect(investedSql).toMatch(/uc\."isSold"\s*=\s*false/);
  });
});

describe("getPlatformStats excludes SOLD rows (BUG-3)", () => {
  it("platform value/invested queries filter isSold = false", async () => {
    prismaMock.user.count.mockResolvedValueOnce(5);
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ total: 12 }]) // platform value (filtered)
      .mockResolvedValueOnce([{ total: 10 }]); // platform invested (filtered)
    prismaMock.userCollection.aggregate.mockResolvedValueOnce({ _sum: { quantity: 2 } });

    const stats = await getPlatformStats();

    expect(stats.totalPlatformValue).toBe(12); // not 24
    expect(stats.totalInvested).toBe(10); // not 20
    expect(stats.totalCardsTracked).toBe(2); // quantity sum DELIBERATELY counts all rows

    const valueSql = sqlTextOf(prismaMock.$queryRaw.mock.calls[0]);
    const investedSql = sqlTextOf(prismaMock.$queryRaw.mock.calls[1]);
    expect(valueSql).toMatch(/uc\."isSold"\s*=\s*false/);
    expect(investedSql).toMatch(/uc\."isSold"\s*=\s*false/);
  });
});
