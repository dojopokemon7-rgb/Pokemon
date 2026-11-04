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
  buildDetailQueries,
  mapTotals,
  mapTopEvents,
  mapDaily,
  mapFunnel,
  mapLabelCounts,
  mapCardAgg,
  activityDetail,
  mapRecentActivity,
  mapScanner,
  mapRecentErrors,
  mapDetail,
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

describe("detail HogQL builders", () => {
  it("reuse the SAME fixed range/env fragments, never interpolate input", () => {
    const q = buildDetailQueries("24h", "staging");
    for (const sql of Object.values(q)) {
      expect(sql).toContain("INTERVAL 24 HOUR");
      expect(sql).toContain("properties.environment = 'staging'");
    }
    // 'all' env drops the environment predicate entirely.
    for (const sql of Object.values(buildDetailQueries("30d", "all"))) {
      expect(sql).not.toContain("properties.environment =");
      expect(sql).toContain("INTERVAL 30 DAY");
    }
  });
  it("recent activity joins the person for email (never event props) and caps rows", () => {
    const q = buildDetailQueries("7d", "production");
    expect(q.recentActivity).toContain("person.properties.email");
    // Email is read ONLY via the person join — never as a bare event property.
    expect(q.recentActivity.replace(/person\.properties\.email/g, "")).not.toContain("properties.email");
    expect(q.recentActivity).toContain("LIMIT 100");
    // Only business events + $exception — never autocapture/pageview noise.
    expect(q.recentActivity).toContain("event IN ('signup_started'");
    expect(q.recentActivity).toContain("'$exception'");
    expect(q.recentActivity).not.toContain("$autocapture");
    expect(q.recentActivity).not.toContain("$pageview");
  });
  it("list queries cap at 10 rows", () => {
    const q = buildDetailQueries("7d", "all");
    for (const key of ["searchTerms", "zeroResult", "mostViewed", "mostAdded"] as const) {
      expect(q[key]).toContain("LIMIT 10");
    }
  });
});

describe("detail mappers", () => {
  it("mapLabelCounts drops blank labels and null counts", () => {
    expect(mapLabelCounts([["email", 5], ["", 2], ["google", null], ["sort", 3]])).toEqual([
      { label: "email", count: 5 },
      { label: "sort", count: 3 },
    ]);
    expect(mapLabelCounts([])).toEqual([]);
  });
  it("mapCardAgg keeps value when present, null otherwise", () => {
    expect(mapCardAgg([["base1-4", 3, 99.5], ["OP01-064", 2]])).toEqual([
      { cardId: "base1-4", count: 3, valueUsd: 99.5 },
      { cardId: "OP01-064", count: 2, valueUsd: null },
    ]);
    expect(mapCardAgg([["", 1, 2]])).toEqual([]);
  });
  it("activityDetail picks the ONE salient prop per event", () => {
    const row = (event: string, extra: Record<number, unknown> = {}) => {
      const r: unknown[] = ["t", null, event, null, null, null, null, null, null, null, null, null, null];
      for (const [i, v] of Object.entries(extra)) r[Number(i)] = v;
      return r;
    };
    expect(activityDetail(row("card_added", { 3: "base1-4" }))).toBe("base1-4");
    expect(activityDetail(row("search_performed", { 4: "charizard", 5: 12 }))).toBe('"charizard" · 12 results');
    expect(activityDetail(row("search_performed", { 4: "zzz", 5: 0 }))).toBe('"zzz" · 0 results');
    expect(activityDetail(row("search_performed", { 4: "one", 5: 1 }))).toBe('"one" · 1 result');
    expect(activityDetail(row("filter_applied", { 6: "rarity" }))).toBe("rarity");
    expect(activityDetail(row("login_completed", { 7: "google" }))).toBe("google");
    expect(activityDetail(row("scan_failed", { 8: "not_recognized" }))).toBe("not_recognized");
    expect(activityDetail(row("portfolio_chart_viewed", { 9: "1M" }))).toBe("1M");
    expect(activityDetail(row("card_viewed"))).toBeNull(); // no card_id → "—"
  });
  it("mapRecentActivity: identified vs anonymous, values, skips unlabelable rows", () => {
    const rows: unknown[][] = [
      ["2026-01-01T00:00:00Z", "a@b.com", "card_added", "base1-4", null, null, null, null, null, null, 10, 830, "production"],
      ["2026-01-02T00:00:00Z", null, "search_performed", null, "pikachu", 3, null, null, null, null, null, null, "staging"],
      [null, "x@y.com", "card_added", "c", null, null, null, null, null, null, null, null, "production"], // no time → skipped
    ];
    const out = mapRecentActivity(rows);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ email: "a@b.com", event: "card_added", detail: "base1-4", valueUsd: 10, valueInr: 830, environment: "production" });
    expect(out[1]).toMatchObject({ email: null, detail: '"pikachu" · 3 results', valueUsd: null, valueInr: null });
  });
  it("mapScanner computes success rate and null-safes empties", () => {
    expect(mapScanner([[10, 8, 2]], [["not_recognized", 2]], [["pokemon", 6]])).toMatchObject({
      started: 10,
      succeeded: 8,
      failed: 2,
      successRate: 80,
      failReasons: [{ label: "not_recognized", count: 2 }],
      byGame: [{ label: "pokemon", count: 6 }],
    });
    // No resolved scans → null rate (never a fabricated 0%).
    expect(mapScanner([[null, null, null]], [], []).successRate).toBeNull();
    expect(mapScanner([], [], []).successRate).toBeNull();
  });
  it("mapRecentErrors keeps message/type or null", () => {
    expect(mapRecentErrors([["2026-01-01T00:00:00Z", "boom", "TypeError"], [null, "x", "y"]])).toEqual([
      { time: "2026-01-01T00:00:00Z", message: "boom", type: "TypeError" },
    ]);
  });
  it("mapDetail assembles all sections and handles fully-empty input", () => {
    const empty = {
      errorCount: null,
      recentActivity: [],
      searchTerms: [],
      zeroResult: [],
      mostViewed: [],
      filterTypes: [],
      searchByGame: [],
      mostAdded: [],
      cardsRemoved: [],
      conditionSplit: [],
      portfolioByGame: [],
      chartRanges: [],
      mostWishlisted: [],
      wishlistByGame: [],
      scanCounts: [],
      scanFailReasons: [],
      scanByGame: [],
      signupsByMethod: [],
      loginsByMethod: [],
      activation: [],
      recentErrors: [],
    };
    const out = mapDetail(empty);
    expect(out.recentActivity).toEqual([]);
    expect(out.portfolio.cardsRemoved).toBeNull();
    expect(out.auth.onboardingCompleted).toBeNull();
    expect(out.engagement.errorCount).toBeNull();
    expect(out.scanner.successRate).toBeNull();

    const populated = mapDetail({
      ...empty,
      errorCount: 4,
      cardsRemoved: [[7]],
      conditionSplit: [["raw", 5], ["graded", 2]],
      activation: [[3, 1]],
      signupsByMethod: [["email", 9], ["google", 4]],
    });
    expect(populated.portfolio.cardsRemoved).toBe(7);
    expect(populated.portfolio.conditionSplit).toHaveLength(2);
    expect(populated.auth.onboardingCompleted).toBe(3);
    expect(populated.auth.passwordResetRequested).toBe(1);
    expect(populated.auth.signupsByMethod[0]).toEqual({ label: "email", count: 9 });
    expect(populated.engagement.errorCount).toBe(4);
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
    if (r.status === "ok") {
      expect(r.metrics.pageviews).toBeNull();
      // Detail block is always present (empty rows → honest empty sections).
      expect(r.detail.recentActivity).toEqual([]);
      expect(r.detail.scanner.successRate).toBeNull();
      expect(r.detail.engagement.errorCount).toBeNull();
    }
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
