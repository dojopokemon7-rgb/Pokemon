import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
/**
 * PostHog admin analytics: service (HogQL mapping, response mapping, honest
 * states) + GET /api/admin/analytics route guard. Fetch and Redis are mocked —
 * no network.
 */
vi.mock("@/lib/redis", async () => {
  const actual = await vi.importActual<typeof import("@/lib/redis")>("@/lib/redis");
  return {
    ...actual,
    redis: { get: vi.fn().mockRejectedValue(new Error("redis down")), set: vi.fn() },
  };
});

import {
  buildQueries,
  mapTotals,
  mapTopEvents,
  mapDaily,
  mapFunnel,
  num,
  getPosthogAnalytics,
} from "@/lib/services/posthog-query.service";
import { GET } from "@/app/api/admin/analytics/route";
import { signAdminSession, ADMIN_SESSION_COOKIE } from "@/lib/utils/admin-session";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  process.env.ADMIN_SESSION_SECRET = "posthog-test-secret";
  process.env.ADMIN_EMAIL = "test-admin@example.com";
  process.env.POSTHOG_PERSONAL_API_KEY = "phx_test";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.POSTHOG_PERSONAL_API_KEY;
  delete process.env.ADMIN_SESSION_SECRET;
  delete process.env.ADMIN_EMAIL;
});

const okJson = (results: unknown[][]) =>
  ({ ok: true, status: 200, json: async () => ({ results }) }) as Response;

describe("HogQL builders", () => {
  it("maps range + environment to fixed fragments", () => {
    const q = buildQueries("24h", "staging");
    expect(q.totals).toContain("INTERVAL 24 HOUR");
    expect(q.totals).toContain("properties.environment = 'staging'");
    expect(buildQueries("30d", "all").totals).not.toContain("properties.environment");
    expect(buildQueries("7d", "production").daily).toContain("INTERVAL 7 DAY");
  });
});

describe("response mapping", () => {
  it("maps totals and keeps nulls as null (never 0)", () => {
    const m = mapTotals([[5, 10, 1, 2, 3, 99.5, 4, 1, 0, 6, 5, null]]);
    expect(m.uniqueVisitors).toBe(5);
    expect(m.cardsAddedValueUsd).toBe(99.5);
    expect(m.errors).toBeNull();
    expect(mapTotals([]).pageviews).toBeNull();
    expect(num("12")).toBe(12);
    expect(num(NaN)).toBeNull();
  });
  it("handles empty / malformed rows", () => {
    expect(mapTopEvents([])).toEqual([]);
    expect(mapTopEvents([["card_added", 3], [null, 2]])).toEqual([{ event: "card_added", count: 3 }]);
    expect(mapDaily([["2026-01-01", 4, 2]])).toEqual([{ date: "2026-01-01", pageviews: 4, visitors: 2 }]);
    expect(mapFunnel([]).every((s) => s.users === null)).toBe(true);
  });
});

describe("getPosthogAnalytics", () => {
  it("returns not_configured without a key and makes no request", async () => {
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    expect(await getPosthogAnalytics("7d", "production")).toEqual({ status: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("returns unavailable on PostHog error (no throw)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);
    const r = await getPosthogAnalytics("7d", "production");
    expect(r.status).toBe("unavailable");
  });
  it("calls the Query API with bearer auth + HogQLQuery and survives Redis failure", async () => {
    fetchMock.mockResolvedValue(okJson([]));
    const r = await getPosthogAnalytics("7d", "all");
    expect(r.status).toBe("ok");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://eu.posthog.com/api/projects/333915/query/");
    expect(init.headers.Authorization).toBe("Bearer phx_test");
    expect(JSON.parse(init.body).query.kind).toBe("HogQLQuery");
    if (r.status === "ok") expect(r.metrics.pageviews).toBeNull();
  });
});

describe("GET /api/admin/analytics", () => {
  const req = (qs = "", cookie?: string) =>
    new Request(`http://localhost/api/admin/analytics${qs}`, cookie ? { headers: { cookie } } : undefined);
  const cookie = () => `${ADMIN_SESSION_COOKIE}=${signAdminSession()}`;

  it("401 without an admin session and never queries PostHog", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("400 on an invalid range", async () => {
    expect((await GET(req("?range=1y", cookie()))).status).toBe(400);
  });
  it("200 not_configured for an admin when the key is unset", async () => {
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    const res = await GET(req("", cookie()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "not_configured" });
  });
});
