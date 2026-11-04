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
  buildUserActivityQuery,
  buildCardActivityQuery,
  buildFilteredFeedQuery,
  buildDistinctPersonsQuery,
  buildDistinctPersonsCountQuery,
  mapTotals,
  mapTopEvents,
  mapDaily,
  mapFunnel,
  mapLabelCounts,
  mapCardAgg,
  activityDetail,
  salientDetail,
  resolveFeedUserIds,
  resolvePersonUserIds,
  attachFeedCardNames,
  attachCardAggNames,
  collectCardExternalIds,
  mapRecentActivity,
  mapUserActivity,
  mapCardActivity,
  mapDistinctPersons,
  mapScanner,
  mapRecentErrors,
  mapDetail,
  num,
  getPosthogAnalytics,
  getUserActivity,
  getCardActivity,
  getFilteredFeed,
  getDistinctPersons,
  ANALYTICS_EVENT_FILTERS,
  type ActivityRow,
  type CardAgg,
  type DistinctPerson,
} from "@/lib/services/posthog-query.service";
import { GET } from "@/app/api/admin/analytics/route";
import { GET as GET_CARD } from "@/app/api/admin/analytics/card/route";
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

describe("drill-down HogQL builders", () => {
  it("user activity query filters by the {email} placeholder (never interpolated) + caps rows", () => {
    const q = buildUserActivityQuery(25);
    // Dynamic value flows through the placeholder, NOT the SQL text.
    expect(q).toContain("person.properties.email = {email}");
    expect(q).not.toContain("@"); // no email literal ever baked in
    expect(q).toContain("event IN ('signup_started'");
    expect(q).toContain("'$exception'");
    expect(q).not.toContain("$autocapture");
    expect(q).not.toContain("$pageview");
    expect(q).toContain("LIMIT 25");
    // Limit is clamped 1..100.
    expect(buildUserActivityQuery(5000)).toContain("LIMIT 100");
    expect(buildUserActivityQuery(0)).toContain("LIMIT 1");
  });
  it("card activity query binds the {card_id} placeholder + keeps fixed range/env", () => {
    const q = buildCardActivityQuery("24h", "staging");
    expect(q).toContain("properties.card_id = {card_id}");
    expect(q).toContain("INTERVAL 24 HOUR");
    expect(q).toContain("properties.environment = 'staging'");
    // 'all' env drops the predicate.
    expect(buildCardActivityQuery("30d", "all")).not.toContain("properties.environment =");
    // Single aggregate row — the 5 countIf/sumIf columns, no card id literal.
    expect(q).toContain("countIf(event = 'card_viewed')");
    expect(q).toContain("countIf(event = 'wishlist_added')");
  });
});

describe("drill-down mappers", () => {
  it("salientDetail picks the one prop regardless of column layout", () => {
    expect(salientDetail({ event: "card_added", cardId: "base1-4", query: null, resultsCount: null, filterType: null, method: null, reason: null, range: null })).toBe("base1-4");
    expect(salientDetail({ event: "search_performed", cardId: null, query: "pika", resultsCount: 3, filterType: null, method: null, reason: null, range: null })).toBe('"pika" · 3 results');
    expect(salientDetail({ event: "login_completed", cardId: null, query: null, resultsCount: null, filterType: null, method: "google", reason: null, range: null })).toBe("google");
    // activityDetail delegates to salientDetail (same output).
    const row: unknown[] = ["t", null, "filter_applied", null, null, null, "rarity", null, null, null, null, null, null];
    expect(activityDetail(row)).toBe("rarity");
  });
  it("mapUserActivity maps the per-user column layout and skips unlabelable rows", () => {
    const rows: unknown[][] = [
      ["2026-01-02T00:00:00Z", "card_added", "base1-4", null, null, null, null, null, null, 10, 830, "production"],
      ["2026-01-01T00:00:00Z", "search_performed", null, "pikachu", 0, null, null, null, null, null, null, "staging"],
      [null, "card_added", "c", null, null, null, null, null, null, null, null, "production"], // no time → skipped
      ["2026-01-03T00:00:00Z", null, "c", null, null, null, null, null, null, null, null, "production"], // no event → skipped
    ];
    const out = mapUserActivity(rows);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ event: "card_added", detail: "base1-4", valueUsd: 10, valueInr: 830, environment: "production" });
    expect(out[1]).toMatchObject({ event: "search_performed", detail: '"pikachu" · 0 results', valueUsd: null });
    expect(mapUserActivity([])).toEqual([]);
  });
  it("mapCardActivity maps the single aggregate row and null-safes empties", () => {
    expect(mapCardActivity([[12, 5, 7, 99.5, 3]])).toEqual({
      viewed: 12,
      added: 5,
      addedQuantity: 7,
      addedValueUsd: 99.5,
      wishlisted: 3,
    });
    // Empty result → all null (never a fabricated 0).
    expect(mapCardActivity([])).toEqual({
      viewed: null,
      added: null,
      addedQuantity: null,
      addedValueUsd: null,
      wishlisted: null,
    });
    expect(mapCardActivity([[null, null, null, null, null]]).added).toBeNull();
  });
  it("resolveFeedUserIds links matched emails and leaves anonymous/no-match unlinked", () => {
    const base = (email: string | null): ActivityRow => ({
      time: "t",
      email,
      event: "card_added",
      detail: null,
      valueUsd: null,
      valueInr: null,
      environment: "production",
    });
    const rows = [base("match@x.com"), base("missing@x.com"), base(null)];
    const map = new Map([["match@x.com", "user_123"]]);
    const out = resolveFeedUserIds(rows, map);
    expect(out[0].userId).toBe("user_123"); // match → linked
    expect(out[1].userId).toBeNull(); // no-match → no link
    expect(out[2].userId).toBeNull(); // anonymous → no link
  });
});

describe("getUserActivity", () => {
  it("returns not_configured without a key and makes no request", async () => {
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    expect(await getUserActivity("a@b.com")).toEqual({ status: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("returns ok with an empty list for a blank email (no request)", async () => {
    expect(await getUserActivity("  ")).toEqual({ status: "ok", events: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("binds the email via query.values placeholder (never interpolated) and maps events", async () => {
    fetchMock.mockResolvedValue(
      okJson([["2026-01-01T00:00:00Z", "card_added", "base1-4", null, null, null, null, null, null, 10, null, "production"]])
    );
    const r = await getUserActivity("a@b.com", { limit: 25 });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.events).toHaveLength(1);
      expect(r.events[0]).toMatchObject({ event: "card_added", detail: "base1-4", valueUsd: 10 });
    }
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.query.values).toEqual({ email: "a@b.com" });
    expect(body.query.query).toContain("{email}");
    expect(body.query.query).not.toContain("a@b.com");
  });
  it("returns unavailable on PostHog error (no throw)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);
    expect((await getUserActivity("a@b.com")).status).toBe("unavailable");
  });
});

describe("getCardActivity", () => {
  it("returns not_configured without a key and makes no request", async () => {
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    expect(await getCardActivity("base1-4", "7d", "production")).toEqual({ status: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("binds the card id via query.values placeholder (never interpolated) and maps the aggregate", async () => {
    fetchMock.mockResolvedValue(okJson([[12, 5, 7, 99.5, 3]]));
    const r = await getCardActivity("base1-4", "30d", "all");
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.cardId).toBe("base1-4");
      expect(r.activity).toMatchObject({ viewed: 12, added: 5, addedQuantity: 7, addedValueUsd: 99.5, wishlisted: 3 });
    }
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.query.values).toEqual({ card_id: "base1-4" });
    expect(body.query.query).toContain("{card_id}");
    expect(body.query.query).not.toContain("base1-4");
  });
  it("empty PostHog result → ok with all-null aggregates (never fabricated)", async () => {
    fetchMock.mockResolvedValue(okJson([]));
    const r = await getCardActivity("base1-4", "7d", "production");
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.activity.viewed).toBeNull();
  });
  it("returns unavailable on PostHog error (no throw)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);
    expect((await getCardActivity("base1-4", "7d", "production")).status).toBe("unavailable");
  });
});

describe("GET /api/admin/analytics/card", () => {
  const req = (qs = "", cookie?: string) =>
    new Request(`http://localhost/api/admin/analytics/card${qs}`, cookie ? { headers: { cookie } } : undefined);
  const cookie = () => `${ADMIN_SESSION_COOKIE}=${signAdminSession()}`;

  it("401 without an admin session and never queries PostHog", async () => {
    const res = await GET_CARD(req("?cardId=base1-4"));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("400 without a cardId", async () => {
    expect((await GET_CARD(req("", cookie())))).toHaveProperty("status", 400);
  });
  it("200 not_configured for an admin when the key is unset", async () => {
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    const res = await GET_CARD(req("?cardId=base1-4", cookie()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "not_configured" });
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

describe("count-card drill-down: event filter → constant HogQL fragment", () => {
  it("maps each allowlisted filter to a CONSTANT event predicate (no interpolation)", () => {
    // Every allowlisted value yields a fixed predicate + fixed range/env frags.
    for (const f of ANALYTICS_EVENT_FILTERS) {
      const sql = buildFilteredFeedQuery(f, "7d", "production");
      expect(sql).toContain("INTERVAL 7 DAY");
      expect(sql).toContain("properties.environment = 'production'");
      expect(sql).toContain("LIMIT 100");
      // Same person-join + column layout as the main feed (shared mapper).
      expect(sql).toContain("person.properties.email");
    }
    // Each filter's predicate is its own event name (or the zero_result pseudo).
    expect(buildFilteredFeedQuery("login_completed", "24h", "all")).toContain("event = 'login_completed'");
    expect(buildFilteredFeedQuery("$exception", "24h", "all")).toContain("event = '$exception'");
    expect(buildFilteredFeedQuery("zero_result", "24h", "all")).toContain(
      "event = 'search_performed' AND toFloat(properties.results_count) = 0"
    );
    // 'all' env drops the environment predicate.
    expect(buildFilteredFeedQuery("card_added", "30d", "all")).not.toContain("properties.environment =");
  });
  it("allowlist is a fixed taxonomy set + zero_result + $exception (no free text)", () => {
    expect([...ANALYTICS_EVENT_FILTERS].sort()).toEqual(
      [
        "$exception",
        "card_added",
        "login_completed",
        "scan_started",
        "scan_succeeded",
        "search_performed",
        "signup_completed",
        "wishlist_added",
        "zero_result",
      ].sort()
    );
  });
});

describe("unique-visitors drill-down: distinct persons", () => {
  it("person queries use fixed range/env fragments and cap the list", () => {
    const q = buildDistinctPersonsQuery("24h", "staging");
    expect(q).toContain("INTERVAL 24 HOUR");
    expect(q).toContain("properties.environment = 'staging'");
    expect(q).toContain("person.properties.email");
    expect(q).toContain("LIMIT 200");
    const c = buildDistinctPersonsCountQuery("7d", "all");
    expect(c).toContain("uniq(distinct_id)");
    expect(c).toContain("empty(toString(person.properties.email))");
    expect(c).not.toContain("properties.environment ="); // 'all' drops it
  });
  it("mapDistinctPersons lists identified + honest anonymous/total from the count row", () => {
    const persons: unknown[][] = [["a@b.com", 10], ["", 5], ["c@d.com", 3], ["a@b.com", 1]];
    const counts: unknown[][] = [[9, 4]]; // total 9, anonymous 4 (authoritative)
    const out = mapDistinctPersons(persons, counts);
    // De-duped identified list, blank email dropped, never fabricates identity.
    expect(out.identified).toEqual([{ email: "a@b.com" }, { email: "c@d.com" }]);
    // anonymous comes from the count query, NOT the capped list length.
    expect(out.anonymous).toBe(4);
    expect(out.total).toBe(9);
    // Empty input → zeros, never nulls that would render as a fabricated row.
    expect(mapDistinctPersons([], [])).toEqual({ identified: [], anonymous: 0, total: 0 });
  });
  it("resolvePersonUserIds links matched emails, leaves unmatched unlinked", () => {
    const persons: DistinctPerson[] = [{ email: "a@b.com" }, { email: "gone@x.com" }];
    const out = resolvePersonUserIds(persons, new Map([["a@b.com", "user_1"]]));
    expect(out[0].userId).toBe("user_1");
    expect(out[1].userId).toBeNull();
  });
});

describe("card name resolution (externalId → name, batch, no N+1)", () => {
  const feedRow = (event: string, detail: string | null): ActivityRow => ({
    time: "t",
    email: null,
    event,
    detail,
    valueUsd: null,
    valueInr: null,
    environment: "production",
  });
  it("collectCardExternalIds de-dupes across feeds + card lists, card-detail rows only", () => {
    const feed = [
      feedRow("card_added", "base1-4"),
      feedRow("search_performed", "charizard"), // NOT a card id → excluded
      feedRow("card_viewed", "base1-4"), // dup
      feedRow("login_completed", null),
    ];
    const lists: CardAgg[][] = [
      [{ cardId: "OP01-064", count: 2, valueUsd: null }],
      [{ cardId: "base1-4", count: 1, valueUsd: null }], // dup across sources
    ];
    expect(collectCardExternalIds([feed], lists).sort()).toEqual(["OP01-064", "base1-4"]);
  });
  it("attachFeedCardNames: match → name, miss → null (raw id in UI), non-card → null", () => {
    const rows = [feedRow("card_added", "base1-4"), feedRow("card_viewed", "unknown-9"), feedRow("search_performed", "pika")];
    const names = new Map([["base1-4", "Mew"]]);
    const out = attachFeedCardNames(rows, names);
    expect(out[0].cardName).toBe("Mew"); // match
    expect(out[1].cardName).toBeNull(); // miss → fall back to raw id
    expect(out[2].cardName).toBeNull(); // not a card-detail event
  });
  it("attachCardAggNames: match → name, miss → null", () => {
    const out = attachCardAggNames(
      [
        { cardId: "base1-4", count: 3, valueUsd: 9 },
        { cardId: "ME55-B", count: 1, valueUsd: null },
      ],
      new Map([["base1-4", "Pikachu"]])
    );
    expect(out[0].cardName).toBe("Pikachu");
    expect(out[1].cardName).toBeNull();
  });
});

describe("getFilteredFeed / getDistinctPersons services", () => {
  it("getFilteredFeed: not_configured without a key, no request", async () => {
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    expect(await getFilteredFeed("login_completed", "7d", "production")).toEqual({ status: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("getFilteredFeed: maps the scoped rows and keeps the filter", async () => {
    fetchMock.mockResolvedValue(
      okJson([["2026-01-01T00:00:00Z", "a@b.com", "login_completed", null, null, null, null, "google", null, null, null, null, "production"]])
    );
    const r = await getFilteredFeed("login_completed", "7d", "production");
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.filter).toBe("login_completed");
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ email: "a@b.com", event: "login_completed", detail: "google" });
    }
  });
  it("getFilteredFeed: unavailable on PostHog error (no throw)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);
    expect((await getFilteredFeed("card_added", "7d", "production")).status).toBe("unavailable");
  });
  it("getDistinctPersons: not_configured without a key, no request", async () => {
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    expect(await getDistinctPersons("7d", "production")).toEqual({ status: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("getDistinctPersons: identified + anonymous remainder, never fabricated", async () => {
    // Two queries in order: ranked persons, then the total/anonymous counts.
    fetchMock
      .mockResolvedValueOnce(okJson([["a@b.com", 5], ["", 2]]))
      .mockResolvedValueOnce(okJson([[7, 3]]));
    const r = await getDistinctPersons("7d", "production");
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.identified).toEqual([{ email: "a@b.com" }]);
      expect(r.anonymous).toBe(3);
      expect(r.total).toBe(7);
    }
  });
  it("getDistinctPersons: unavailable on PostHog error (no throw)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);
    expect((await getDistinctPersons("7d", "production")).status).toBe("unavailable");
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
  it("400 on a free-text / out-of-allowlist event filter (never interpolated)", async () => {
    // Anything outside the fixed allowlist is rejected at the Zod boundary.
    expect((await GET(req("?event=DROP TABLE", cookie()))).status).toBe(400);
    expect((await GET(req("?event=card_viewed", cookie()))).status).toBe(400); // real event, not an allowed FILTER
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("400 on an unknown view value", async () => {
    expect((await GET(req("?view=everything", cookie()))).status).toBe(400);
  });
  it("200 not_configured for an admin when the key is unset (default view)", async () => {
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    const res = await GET(req("", cookie()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "not_configured" });
  });
  it("200 not_configured for the event-filter drill-down when the key is unset", async () => {
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    const res = await GET(req("?event=login_completed", cookie()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "not_configured" });
  });
  it("200 not_configured for the persons drill-down when the key is unset", async () => {
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    const res = await GET(req("?view=persons", cookie()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "not_configured" });
  });
});
