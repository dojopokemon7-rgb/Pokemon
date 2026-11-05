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
  buildDimensionFeedQuery,
  buildDistinctPersonsQuery,
  buildDistinctPersonsCountQuery,
  buildRetentionQuery,
  buildSignupCohortQuery,
  buildSignupAttributionQueries,
  retentionPercents,
  shapeSignupCohorts,
  bucketUtm,
  getRetention,
  getSignupCohorts,
  getSignupAttribution,
  isAllowedDimensionValue,
  getDimensionFeed,
  ANALYTICS_DIMENSIONS,
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
  it("totals adds distinct-PERSON metrics on uniq(person_id), never distinct_id", () => {
    const q = buildQueries("7d", "production").totals;
    // DAU/WAU/collectors are distinct PERSONS (de-duped across sessions).
    expect(q).toContain("uniq(person_id)");
    expect(q).toContain("uniqIf(person_id, timestamp >= now() - INTERVAL 24 HOUR)"); // DAU
    expect(q).toContain("uniqIf(person_id, timestamp >= now() - INTERVAL 7 DAY)"); // WAU
    expect(q).toContain(
      "uniqIf(person_id, event IN ('card_added', 'card_removed') AND timestamp >= now() - INTERVAL 7 DAY)"
    ); // weekly active collectors
    // The window-wide Unique Visitors metric is unchanged (distinct_id).
    expect(q).toContain("uniq(distinct_id)");
  });
});

describe("retention / cohort / attribution HogQL builders (audit items 3-5)", () => {
  it("buildRetentionQuery anchors on first_seen, uses person_id + dateDiff buckets, env is a constant fragment", () => {
    const q = buildRetentionQuery("production");
    expect(q).toContain("min(toDate(timestamp))"); // first-seen anchor
    expect(q).toContain("GROUP BY person_id");
    expect(q).toContain("dateDiff('day', f.first_day, a.act_day) = 1");
    expect(q).toContain("dateDiff('day', f.first_day, a.act_day) = 7");
    expect(q).toContain("dateDiff('day', f.first_day, a.act_day) = 30");
    // "returned" = any business event EXCEPT $exception.
    expect(q).toContain("event IN ('signup_started'");
    expect(q).not.toContain("'$exception'");
    // Env is a constant allowlist fragment; 'all' drops it.
    expect(q).toContain("properties.environment = 'production'");
    expect(buildRetentionQuery("all")).not.toContain("properties.environment =");
  });
  it("buildSignupCohortQuery groups by signup week + counts following-week returners + per-week elapsed flag", () => {
    const q = buildSignupCohortQuery("staging");
    expect(q).toContain("toStartOfWeek(min(timestamp))");
    expect(q).toContain("event = 'signup_completed'");
    expect(q).toContain("dateDiff('week', s.cohort_week, a.act_week) = 1");
    expect(q).toContain("dateDiff('week', s.cohort_week, a.act_week) = 4");
    // Per-offset observable flag: the following week must have fully elapsed.
    expect(q).toContain("dateDiff('week', s.cohort_week, toStartOfWeek(now())) >= 1");
    expect(q).toContain("dateDiff('week', s.cohort_week, toStartOfWeek(now())) >= 4");
    expect(q).toContain("properties.environment = 'staging'");
    expect(q).toContain("LIMIT 10");
    expect(buildSignupCohortQuery("all")).not.toContain("properties.environment =");
  });
  it("buildSignupAttributionQueries read initial-touch person props, count distinct persons, no interpolation", () => {
    const q = buildSignupAttributionQueries("30d", "production");
    expect(q.bySource).toContain("person.properties.$initial_utm_source");
    expect(q.byMedium).toContain("person.properties.$initial_utm_medium");
    expect(q.byCampaign).toContain("person.properties.$initial_utm_campaign");
    for (const sql of Object.values(q)) {
      expect(sql).toContain("uniq(person_id)"); // distinct persons, not events
      expect(sql).toContain("event = 'signup_completed'");
      expect(sql).toContain("INTERVAL 30 DAY");
      expect(sql).toContain("properties.environment = 'production'");
    }
    for (const sql of Object.values(buildSignupAttributionQueries("7d", "all"))) {
      expect(sql).not.toContain("properties.environment =");
    }
  });
});

describe("retention / cohort / attribution mappers (pure)", () => {
  it("retentionPercents: % per bucket, zero/null cohort → null (never 0% / 100%)", () => {
    // [cohortSize, d1cohort, d1ret, d7cohort, d7ret, d30cohort, d30ret]
    const r = retentionPercents([[100, 100, 40, 80, 20, 50, 5]]);
    expect(r.cohortSize).toBe(100);
    expect(r.d1).toBe(40); // 40/100
    expect(r.d7).toBe(25); // 20/80
    expect(r.d30).toBe(10); // 5/50
    // Zero/empty cohort for a bucket → null, never a fabricated number.
    const z = retentionPercents([[0, 0, 0, 0, 0, 0, 0]]);
    expect(z.d1).toBeNull();
    expect(z.d7).toBeNull();
    expect(z.d30).toBeNull();
    const empty = retentionPercents([]);
    expect(empty.cohortSize).toBeNull();
    expect(empty.d1).toBeNull();
  });
  it("shapeSignupCohorts: % of cohort, elapsed 0 → 0% but not-yet-elapsed → '—', empty week dropped, zero-size → null", () => {
    // Columns: [week, size, w1, w2, w3, w4, elapsed1, elapsed2, elapsed3, elapsed4].
    const rows: unknown[][] = [
      // Fully elapsed cohort: W4 elapsed with 0 returns renders as a real 0%.
      ["2026-01-05", 10, 5, 2, 1, 0, true, true, true, true],
      [null, 4, 1, 1, 1, 1, true, true, true, true], // no week → dropped
      ["2026-01-12", 0, 0, 0, 0, 0, true, true, true, true], // zero cohort → all null
      // Recent "Size 1" cohort: only W1 has elapsed (0 returns → 0%); W2-W4 not
      // yet observable → "—", NOT 0% (the staging defect).
      ["2026-02-02", 1, 0, 0, 0, 0, true, false, false, false],
    ];
    const out = shapeSignupCohorts(rows);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ week: "2026-01-05", size: 10 });
    expect(out[0].returns).toEqual([50, 20, 10, 0]); // % of 10; elapsed 0 → 0%
    expect(out[1]).toMatchObject({ week: "2026-01-12", size: 0 });
    expect(out[1].returns).toEqual([null, null, null, null]); // zero-size row
    expect(out[2]).toMatchObject({ week: "2026-02-02", size: 1 });
    // Elapsed W1 with 0 returns → real 0%; not-yet-elapsed W2-W4 → null ("—").
    expect(out[2].returns).toEqual([0, null, null, null]);
    expect(shapeSignupCohorts([])).toEqual([]);
  });
  it("bucketUtm: present label kept, missing/blank → 'direct / none' (never blank/fabricated)", () => {
    const out = bucketUtm([
      ["instagram", 12],
      ["comic_con_qr", 7],
      [null, 5], // no initial-touch UTM
      ["", 3], // blank → merges into direct
    ]);
    // Sorted highest-first; the two blank variants merge into one direct row.
    expect(out).toEqual([
      { label: "instagram", count: 12 },
      { label: "direct / none", count: 8 },
      { label: "comic_con_qr", count: 7 },
    ]);
    // Null count rows dropped; no fabricated zero.
    expect(bucketUtm([["x", null]])).toEqual([]);
    expect(bucketUtm([])).toEqual([]);
  });
});

describe("getRetention / getSignupCohorts / getSignupAttribution services", () => {
  it("getRetention: not_configured without a key, no request", async () => {
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    expect(await getRetention("production")).toEqual({ status: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("getRetention: maps the aggregate row to D1/D7/D30 percentages", async () => {
    fetchMock.mockResolvedValue(okJson([[100, 100, 40, 80, 20, 50, 5]]));
    const r = await getRetention("production");
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.cohortSize).toBe(100);
      expect(r.d1).toBe(40);
      expect(r.d7).toBe(25);
      expect(r.d30).toBe(10);
    }
  });
  it("getRetention: empty result → ok with null percentages (never fabricated)", async () => {
    fetchMock.mockResolvedValue(okJson([]));
    const r = await getRetention("all");
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.cohortSize).toBeNull();
      expect(r.d1).toBeNull();
    }
  });
  it("getRetention: unavailable on PostHog error (no throw)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);
    expect((await getRetention("production")).status).toBe("unavailable");
  });
  it("getSignupCohorts: not_configured without a key, no request", async () => {
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    expect(await getSignupCohorts("production")).toEqual({ status: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("getSignupCohorts: shapes weekly rows (elapsed 0 → 0%, not-yet-elapsed → null)", async () => {
    fetchMock.mockResolvedValue(
      okJson([
        ["2026-01-05", 10, 5, 2, 1, 0, true, true, true, true],
        ["2026-02-02", 1, 0, 0, 0, 0, true, false, false, false],
      ]),
    );
    const r = await getSignupCohorts("production");
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.cohorts).toHaveLength(2);
      expect(r.cohorts[0].returns).toEqual([50, 20, 10, 0]);
      // Size-1 recent cohort: elapsed W1 0% real, W2-W4 not observable → "—".
      expect(r.cohorts[1].returns).toEqual([0, null, null, null]);
    }
  });
  it("getSignupCohorts: unavailable on PostHog error (no throw)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);
    expect((await getSignupCohorts("production")).status).toBe("unavailable");
  });
  it("getSignupAttribution: not_configured without a key, no request", async () => {
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    expect(await getSignupAttribution("7d", "production")).toEqual({ status: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("getSignupAttribution: buckets the three UTM breakdowns (missing → 'direct / none')", async () => {
    // Three queries in order: source, medium, campaign.
    fetchMock
      .mockResolvedValueOnce(okJson([["instagram", 12], [null, 5]]))
      .mockResolvedValueOnce(okJson([["social", 10]]))
      .mockResolvedValueOnce(okJson([["", 7]]));
    const r = await getSignupAttribution("30d", "production");
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.bySource).toEqual([
        { label: "instagram", count: 12 },
        { label: "direct / none", count: 5 },
      ]);
      expect(r.byMedium).toEqual([{ label: "social", count: 10 }]);
      expect(r.byCampaign).toEqual([{ label: "direct / none", count: 7 }]);
    }
  });
  it("getSignupAttribution: unavailable on PostHog error (no throw)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);
    expect((await getSignupAttribution("7d", "production")).status).toBe("unavailable");
  });
});

describe("response mapping", () => {
  it("maps totals and keeps nulls as null (never 0)", () => {
    // 16 columns now: the original 12 + distinctUsers/dau/wau/collectors (12-15).
    const m = mapTotals([[5, 10, 1, 2, 3, 99.5, 4, 1, 0, 6, 5, null, 8, 3, 7, 2]]);
    expect(m.uniqueVisitors).toBe(5);
    expect(m.cardsAddedValueUsd).toBe(99.5);
    expect(m.errors).toBeNull();
    // Distinct-PERSON metrics (uniq(person_id)).
    expect(m.distinctUsers).toBe(8);
    expect(m.dau).toBe(3);
    expect(m.wau).toBe(7);
    expect(m.weeklyActiveCollectors).toBe(2);
    // Empty row → every metric null (including the new person columns).
    const empty = mapTotals([]);
    expect(empty.pageviews).toBeNull();
    expect(empty.dau).toBeNull();
    expect(empty.wau).toBeNull();
    expect(empty.weeklyActiveCollectors).toBeNull();
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
      // New distinct-person metrics present + null on empty (never fabricated 0).
      expect(r.metrics.dau).toBeNull();
      expect(r.metrics.wau).toBeNull();
      expect(r.metrics.weeklyActiveCollectors).toBeNull();
      // Detail block is always present (empty rows → honest empty sections).
      expect(r.detail.recentActivity).toEqual([]);
      expect(r.detail.scanner.successRate).toBeNull();
      expect(r.detail.engagement.errorCount).toBeNull();
      // Audit items 3-5 folded into the ok payload, empty-safe.
      expect(r.retention.status).toBe("ok");
      if (r.retention.status === "ok") expect(r.retention.d1).toBeNull();
      expect(r.signupCohorts.status).toBe("ok");
      if (r.signupCohorts.status === "ok") expect(r.signupCohorts.cohorts).toEqual([]);
      expect(r.signupAttribution.status).toBe("ok");
      if (r.signupAttribution.status === "ok") expect(r.signupAttribution.bySource).toEqual([]);
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

describe("per-feature row drill-down: dimension → constant HogQL predicate", () => {
  it("allowlist is the fixed set of per-feature dimensions (no free text)", () => {
    expect([...ANALYTICS_DIMENSIONS].sort()).toEqual(
      [
        "filter_type",
        "login_method",
        "scan_reason",
        "search_term",
        "signup_method",
        "zero_result_term",
      ].sort()
    );
  });
  it("every dimension yields a constant predicate + fixed range/env + {value} placeholder, never a literal", () => {
    for (const dim of ANALYTICS_DIMENSIONS) {
      const sql = buildDimensionFeedQuery(dim, "7d", "production");
      expect(sql).toContain("INTERVAL 7 DAY");
      expect(sql).toContain("properties.environment = 'production'");
      expect(sql).toContain("LIMIT 100");
      // Same person-join + column layout as the main feed (shared mapper).
      expect(sql).toContain("person.properties.email");
      // Dynamic value flows ONLY through the placeholder, never the SQL text.
      expect(sql).toContain("{value}");
    }
    // Each dimension's predicate is its own fixed event + prop match.
    expect(buildDimensionFeedQuery("search_term", "24h", "all")).toContain(
      "event = 'search_performed' AND properties.query = {value}"
    );
    expect(buildDimensionFeedQuery("zero_result_term", "24h", "all")).toContain(
      "event = 'search_performed' AND toFloat(properties.results_count) = 0 AND properties.query = {value}"
    );
    expect(buildDimensionFeedQuery("filter_type", "24h", "all")).toContain(
      "event = 'filter_applied' AND properties.filter_type = {value}"
    );
    expect(buildDimensionFeedQuery("scan_reason", "24h", "all")).toContain(
      "event = 'scan_failed' AND properties.reason = {value}"
    );
    expect(buildDimensionFeedQuery("signup_method", "24h", "all")).toContain(
      "event = 'signup_completed' AND properties.method = {value}"
    );
    expect(buildDimensionFeedQuery("login_method", "24h", "all")).toContain(
      "event = 'login_completed' AND properties.method = {value}"
    );
    // 'all' env drops the environment predicate.
    expect(buildDimensionFeedQuery("search_term", "30d", "all")).not.toContain("properties.environment =");
  });
  it("isAllowedDimensionValue double-guards categorical values and passes free text", () => {
    // Categorical: ONLY the fixed enum (the taxonomy in docs/ANALYTICS_EVENTS.md).
    for (const v of ["set", "rarity", "graded", "minPrice", "maxPrice", "hasPrice", "language", "sort"]) {
      expect(isAllowedDimensionValue("filter_type", v)).toBe(true);
    }
    expect(isAllowedDimensionValue("filter_type", "DROP TABLE")).toBe(false);
    expect(isAllowedDimensionValue("scan_reason", "not_recognized")).toBe(true);
    expect(isAllowedDimensionValue("scan_reason", "error")).toBe(true);
    expect(isAllowedDimensionValue("scan_reason", "boom")).toBe(false);
    expect(isAllowedDimensionValue("signup_method", "email")).toBe(true);
    expect(isAllowedDimensionValue("signup_method", "github")).toBe(false);
    expect(isAllowedDimensionValue("login_method", "google")).toBe(true);
    // Free-text dimensions: any non-empty value is allowed (still placeholder-bound).
    expect(isAllowedDimensionValue("search_term", "charizard' OR 1=1")).toBe(true);
    expect(isAllowedDimensionValue("search_term", "  ")).toBe(false);
    expect(isAllowedDimensionValue("zero_result_term", "some query")).toBe(true);
  });
});

describe("getDimensionFeed service", () => {
  it("not_configured without a key, no request", async () => {
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    expect(await getDimensionFeed("search_term", "charizard", "7d", "production")).toEqual({
      status: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("blank value → ok with no rows and NO request", async () => {
    const r = await getDimensionFeed("search_term", "   ", "7d", "production");
    expect(r).toEqual({ status: "ok", dimension: "search_term", value: "", range: "7d", environment: "production", rows: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("binds value via query.values placeholder (never interpolated) and maps rows", async () => {
    fetchMock.mockResolvedValue(
      okJson([["2026-01-01T00:00:00Z", "a@b.com", "search_performed", null, "charizard", 3, null, null, null, null, null, null, "production"]])
    );
    const r = await getDimensionFeed("search_term", "charizard", "7d", "production");
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.dimension).toBe("search_term");
      expect(r.value).toBe("charizard");
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ email: "a@b.com", event: "search_performed", detail: '"charizard" · 3 results' });
    }
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.query.values).toEqual({ value: "charizard" });
    expect(body.query.query).toContain("{value}");
    expect(body.query.query).not.toContain("charizard"); // never a literal
  });
  it("empty PostHog result → ok with no rows (never fabricated)", async () => {
    fetchMock.mockResolvedValue(okJson([]));
    const r = await getDimensionFeed("filter_type", "rarity", "30d", "all");
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.rows).toEqual([]);
  });
  it("unavailable on PostHog error (no throw)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);
    expect((await getDimensionFeed("login_method", "google", "7d", "production")).status).toBe("unavailable");
  });
});

describe("unique-visitors drill-down: distinct persons", () => {
  it("person queries use fixed range/env fragments and cap the list", () => {
    const q = buildDistinctPersonsQuery("24h", "staging");
    expect(q).toContain("INTERVAL 24 HOUR");
    expect(q).toContain("properties.environment = 'staging'");
    expect(q).toContain("person.properties.email");
    expect(q).toContain("LIMIT 200");
    // Identified list is grouped on the PERSON axis (person_id), filtered to
    // non-empty email — so it represents identified PERSONS, not email strings.
    expect(q).toContain("GROUP BY person_id");
    expect(q).toContain("empty(toString(person.properties.email)) = 0");
    const c = buildDistinctPersonsCountQuery("7d", "all");
    // RECONCILIATION FIX: both total and anonymous are measured on person_id
    // (NOT distinct_id), so total = identified + anonymous always holds.
    expect(c).toContain("uniq(person_id)");
    expect(c).toContain("uniqIf(person_id, empty(toString(person.properties.email)))");
    expect(c).not.toContain("uniq(distinct_id)"); // the old session-axis bug
    expect(c).not.toContain("properties.environment ="); // 'all' drops it
  });
  it("mapDistinctPersons derives identifiedCount = total - anonymous (person axis, reconciles)", () => {
    const persons: unknown[][] = [["a@b.com", 10], ["", 5], ["c@d.com", 3], ["a@b.com", 1]];
    const counts: unknown[][] = [[8, 6]]; // total 8, anonymous 6 (authoritative)
    const out = mapDistinctPersons(persons, counts);
    // De-duped identified list, blank email dropped, never fabricates identity.
    expect(out.identified).toEqual([{ email: "a@b.com" }, { email: "c@d.com" }]);
    // anonymous + total come from the count query; identifiedCount is DERIVED.
    expect(out.anonymous).toBe(6);
    expect(out.total).toBe(8);
    expect(out.identifiedCount).toBe(2); // 8 - 6
    // The triple reconciles on the same axis: total = identified + anonymous.
    expect(out.identifiedCount + out.anonymous).toBe(out.total);
    // Empty input → zeros, never nulls that would render as a fabricated row.
    expect(mapDistinctPersons([], [])).toEqual({
      identified: [],
      identifiedCount: 0,
      anonymous: 0,
      total: 0,
    });
  });
  it("mapDistinctPersons can no longer produce the buggy 8/2/0 from consistent inputs", () => {
    // With person-axis counts, 8 distinct persons and 2 identified emails force
    // anonymous = 6 (not the impossible 0 the distinct_id axis produced).
    const persons: unknown[][] = [["a@b.com", 4], ["b@c.com", 2]];
    const out = mapDistinctPersons(persons, [[8, 6]]);
    expect(out.total).toBe(8);
    expect(out.identifiedCount).toBe(2);
    expect(out.anonymous).toBe(6);
    expect(out.anonymous).not.toBe(0);
  });
  it("mapDistinctPersons caps the drill-down list but keeps identifiedCount authoritative", () => {
    // List is capped at PERSONS_LIMIT (2 rows here) while the count query says
    // 5 identified persons → headline uses the count, list stays honestly short.
    const persons: unknown[][] = [["a@b.com", 9], ["b@c.com", 7]];
    const out = mapDistinctPersons(persons, [[6, 1]]); // total 6, anon 1 → 5 identified
    expect(out.identifiedCount).toBe(5);
    expect(out.identified).toHaveLength(2); // capped list < identifiedCount
    expect(out.identified.length).toBeLessThan(out.identifiedCount);
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
  it("getDistinctPersons: reconciling triple on the person axis, never fabricated", async () => {
    // Two queries in order: identified persons (person-axis, non-empty email),
    // then the authoritative person-axis total/anonymous counts.
    fetchMock
      .mockResolvedValueOnce(okJson([["a@b.com", 5], ["c@d.com", 2]]))
      .mockResolvedValueOnce(okJson([[8, 6]])); // total 8, anonymous 6
    const r = await getDistinctPersons("7d", "production");
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.identified).toEqual([{ email: "a@b.com" }, { email: "c@d.com" }]);
      expect(r.anonymous).toBe(6);
      expect(r.total).toBe(8);
      expect(r.identifiedCount).toBe(2); // derived: 8 - 6
      expect(r.identifiedCount + r.anonymous).toBe(r.total); // reconciles
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
  it("400 on an out-of-allowlist dimension (never interpolated)", async () => {
    expect((await GET(req("?dimension=bogus&value=x", cookie()))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("400 on a dimension with no value", async () => {
    expect((await GET(req("?dimension=search_term", cookie()))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("400 on an off-list categorical value (PostHog never called, double-guard)", async () => {
    const res = await GET(req("?dimension=filter_type&value=DROP%20TABLE", cookie()));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("200 not_configured for the dimension drill-down when the key is unset", async () => {
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    const res = await GET(req("?dimension=search_term&value=charizard", cookie()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "not_configured" });
  });
});
