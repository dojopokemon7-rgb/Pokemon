import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/admin/metrics/overview  +  GET /api/admin/metrics/analytics
 *
 * These expose platform-wide financials, user data, and scan activity — a
 * SECURITY BOUNDARY. Every route MUST use the EXISTING requireAdmin guard:
 *   - 401 when unauthenticated,
 *   - 403 when authenticated-but-not-admin (fresh-DB isAdmin:false — never trust
 *     the cookie-cached claim; this matches requireAdmin's real-time revocation),
 *   - 200 with the live aggregate payload ONLY for a fresh-DB admin.
 * The 401/403 responses MUST leak NO aggregate data (no service call, no numbers).
 *
 * Hermetic: mocks @/lib/auth getSession + @/lib/db prisma (the requireAdmin DB
 * re-read) + the admin-metrics service (so no SQL runs). Mirrors the mocking
 * style of tests/unit/auth-guard-admin.test.ts. No live DB/network.
 */

const authMock = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: authMock.getSession } } }));

const prismaMock = vi.hoisted(() => ({ user: { findUnique: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

// Mock the whole service layer so the routes stay the unit under test and no SQL
// runs. Each function returns a sentinel the 200 assertions can match.
const metricsMock = vi.hoisted(() => ({
  getPlatformStats: vi.fn(),
  getRecentPlatformActivity: vi.fn(),
  getScanUsageSeries: vi.fn(),
  getPortfolioTotals: vi.fn(),
  getPerGameSplit: vi.fn(),
  getActiveUsers: vi.fn(),
  getTopCollectedCards: vi.fn(),
  getTopWantedCards: vi.fn(),
  getMostScannedCards: vi.fn(),
}));
vi.mock("@/lib/services/admin-metrics", () => metricsMock);

import { GET as overviewGET } from "@/app/api/admin/metrics/overview/route";
import { GET as analyticsGET } from "@/app/api/admin/metrics/analytics/route";

const req = (path: string) => new Request(`http://localhost${path}`);

const PLATFORM_STATS = {
  totalUsers: 3,
  totalPlatformValue: 100,
  totalInvested: 50,
  totalCardsTracked: 12,
  activeFloorListings: 0,
};
const SCAN_SERIES = {
  points: [],
  totalScans: 4,
  successfulScans: 3,
  failedScans: 1,
  estimatedVisionCredits: 15,
};
const PORTFOLIO = {
  totalPortfolioValue: 100,
  activeCards: 12,
  totalUsers: 3,
  averageCollectionSize: 4,
};
const PER_GAME = { pokemon: 8, onePiece: 4 };
const ACTIVE_USERS = { dau: 1, wau: 2 };
const TOP_COLLECTED = [{ cardId: "base1-4", name: "Charizard", totalQuantity: 5 }];
const TOP_WANTED = [{ cardId: "base1-4", name: "Charizard", count: 3 }];
const MOST_SCANNED = [{ cardId: "OP01-064", name: "Zoro", count: 2 }];

beforeEach(() => {
  vi.clearAllMocks();
  metricsMock.getPlatformStats.mockResolvedValue(PLATFORM_STATS);
  metricsMock.getRecentPlatformActivity.mockResolvedValue([]);
  metricsMock.getScanUsageSeries.mockResolvedValue(SCAN_SERIES);
  metricsMock.getPortfolioTotals.mockResolvedValue(PORTFOLIO);
  metricsMock.getPerGameSplit.mockResolvedValue(PER_GAME);
  metricsMock.getActiveUsers.mockResolvedValue(ACTIVE_USERS);
  metricsMock.getTopCollectedCards.mockResolvedValue(TOP_COLLECTED);
  metricsMock.getTopWantedCards.mockResolvedValue(TOP_WANTED);
  metricsMock.getMostScannedCards.mockResolvedValue(MOST_SCANNED);
});

/** Every service aggregator — assert NONE ran on a rejected request. */
function expectNoServiceCalls() {
  for (const fn of Object.values(metricsMock)) {
    expect(fn).not.toHaveBeenCalled();
  }
}

describe.each([
  ["overview", "/api/admin/metrics/overview", overviewGET],
  ["analytics", "/api/admin/metrics/analytics", analyticsGET],
])("GET /api/admin/metrics/%s — requireAdmin guard", (_name, path, handler) => {
  it("returns 401 when unauthenticated and leaks no aggregate data", async () => {
    authMock.getSession.mockResolvedValue(null);

    const res = await handler(req(path));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
    expectNoServiceCalls();
    // Fresh-DB admin check never runs for an unauthenticated request.
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns 403 when authenticated but NOT admin (fresh-DB isAdmin:false) and leaks no aggregate data", async () => {
    authMock.getSession.mockResolvedValue({ user: { id: "u1", isAdmin: true } });
    prismaMock.user.findUnique.mockResolvedValue({ isAdmin: false });

    const res = await handler(req(path));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden");
    expectNoServiceCalls();
  });
});

describe("GET /api/admin/metrics/overview — admin payload", () => {
  it("returns 200 with the live overview aggregates for a fresh-DB admin", async () => {
    authMock.getSession.mockResolvedValue({ user: { id: "admin1" } });
    prismaMock.user.findUnique.mockResolvedValue({ isAdmin: true });

    const res = await overviewGET(req("/api/admin/metrics/overview"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.stats).toEqual(PLATFORM_STATS);
    expect(body.activeUsers).toEqual(ACTIVE_USERS);
    expect(metricsMock.getPlatformStats).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/admin/metrics/analytics — admin payload", () => {
  it("returns 200 with every detail aggregate for a fresh-DB admin", async () => {
    authMock.getSession.mockResolvedValue({ user: { id: "admin1" } });
    prismaMock.user.findUnique.mockResolvedValue({ isAdmin: true });

    const res = await analyticsGET(req("/api/admin/metrics/analytics"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.scanUsage).toEqual(SCAN_SERIES);
    expect(body.portfolioTotals).toEqual(PORTFOLIO);
    expect(body.perGameSplit).toEqual(PER_GAME);
    expect(body.activeUsers).toEqual(ACTIVE_USERS);
    expect(body.topCollected).toEqual(TOP_COLLECTED);
    expect(body.topWanted).toEqual(TOP_WANTED);
    expect(body.mostScanned).toEqual(MOST_SCANNED);
    expect(metricsMock.getScanUsageSeries).toHaveBeenCalledTimes(1);
  });
});
