import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * GET /api/admin/metrics/overview  +  GET /api/admin/metrics/analytics
 *
 * These expose platform-wide financials, user data, and scan activity — a
 * SECURITY BOUNDARY. Both routes guard with `requireAdmin`, which now gates on
 * the ISOLATED admin session cookie (`dojo_admin_session`), NOT Better Auth /
 * Prisma `isAdmin` (retired as an auth source). So:
 *   - 401 when there is no valid admin session cookie,
 *   - 200 with the live aggregate payload ONLY for a valid signed admin session.
 * The 401 response MUST leak NO aggregate data (no service call, no numbers).
 *
 * (There is no longer an "authenticated-but-not-admin → 403" tier: a visitor
 * either holds a valid signed admin session or does not. A normal Better Auth
 * user — even one that used to be a DB admin — simply has no admin cookie and
 * gets the same 401 as an anonymous caller.)
 *
 * Hermetic: mocks the admin-metrics service (so no SQL runs). A real signed
 * admin-session token is minted for the 200 case using the test secret.
 */

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
import { signAdminSession, ADMIN_SESSION_COOKIE } from "@/lib/utils/admin-session";

const ADMIN_SECRET = "metrics-test-admin-secret";

const req = (path: string, cookie?: string) =>
  new Request(`http://localhost${path}`, cookie ? { headers: { cookie } } : undefined);

const adminCookie = () => `${ADMIN_SESSION_COOKIE}=${signAdminSession()}`;

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
  process.env.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  // Throwaway dummy email — the real admin email lives only in .env (gitignored).
  process.env.ADMIN_EMAIL = "test-admin@example.com";
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

afterEach(() => {
  delete process.env.ADMIN_SESSION_SECRET;
  delete process.env.ADMIN_EMAIL;
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
  it("returns 401 with no admin session cookie and leaks no aggregate data", async () => {
    const res = await handler(req(path));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
    expectNoServiceCalls();
  });

  it("returns 401 with an invalid/tampered admin session cookie and leaks no aggregate data", async () => {
    const res = await handler(req(path, `${ADMIN_SESSION_COOKIE}=not-a-valid-token`));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
    expectNoServiceCalls();
  });
});

describe("GET /api/admin/metrics/overview — admin payload", () => {
  it("returns 200 with the live overview aggregates for a valid admin session", async () => {
    const res = await overviewGET(req("/api/admin/metrics/overview", adminCookie()));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.stats).toEqual(PLATFORM_STATS);
    expect(body.activeUsers).toEqual(ACTIVE_USERS);
    expect(metricsMock.getPlatformStats).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/admin/metrics/analytics — admin payload", () => {
  it("returns 200 with every detail aggregate for a valid admin session", async () => {
    const res = await analyticsGET(req("/api/admin/metrics/analytics", adminCookie()));
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
