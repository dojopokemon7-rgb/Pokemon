/**
 * PostHog Query API service — SERVER-ONLY.
 *
 * Powers the in-app admin analytics dashboard (/admin/analytics). Reads the
 * events the client tracker (src/lib/analytics/track.ts) already ships to
 * PostHog EU, via `POST {host}/api/projects/{id}/query/` with a HogQLQuery
 * body and `Authorization: Bearer <personal API key>`.
 *
 * SECURITY (AGENTS.md RULE 6): POSTHOG_PERSONAL_API_KEY is a server secret.
 * Never NEXT_PUBLIC, never returned to the browser. Do not import this module
 * from client code (client files may `import type` only).
 *
 * HONESTY (RULE 2): never fabricate. Unset key → `not_configured`; PostHog
 * error/timeout/bad shape → `unavailable`; a metric PostHog gave no value for →
 * `null` (UI renders "—"). Always resolves (never throws) so the route/page
 * stay HTTP 200.
 *
 * CACHE (RULE 1): successful results are cached in Redis for ~90s; any Redis
 * failure falls through to a live query.
 *
 * HogQL SAFETY: range/environment are validated against fixed allowlists and
 * mapped to constant SQL fragments below — user input is never interpolated.
 */
import { z } from "zod";
import { redis, RedisKeys, CACHE_TTL } from "@/lib/redis";

export const ANALYTICS_RANGES = ["24h", "7d", "30d"] as const;
export const ANALYTICS_ENVIRONMENTS = ["production", "staging", "all"] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];
export type AnalyticsEnvironment = (typeof ANALYTICS_ENVIRONMENTS)[number];

// Fixed allowlist → constant SQL fragments (the ONLY text that reaches HogQL).
const RANGE_SQL: Record<AnalyticsRange, string> = {
  "24h": "timestamp >= now() - INTERVAL 24 HOUR",
  "7d": "timestamp >= now() - INTERVAL 7 DAY",
  "30d": "timestamp >= now() - INTERVAL 30 DAY",
};
const ENV_SQL: Record<AnalyticsEnvironment, string> = {
  production: "AND properties.environment = 'production'",
  staging: "AND properties.environment = 'staging'",
  all: "",
};

// The named taxonomy events (docs/ANALYTICS_EVENTS.md) + $exception — the only
// "business" events the manager feed shows. Autocapture/$pageview/$pageleave/
// web-vitals noise is deliberately excluded. This is a CONSTANT SQL list
// literal; no user input ever reaches it.
const BUSINESS_EVENTS = [
  "signup_started",
  "signup_completed",
  "onboarding_completed",
  "login_completed",
  "password_reset_requested",
  "first_card_added",
  "portfolio_viewed",
  "card_added",
  "card_removed",
  "portfolio_chart_viewed",
  "search_performed",
  "card_viewed",
  "filter_applied",
  "wishlist_added",
  "scan_started",
  "scan_succeeded",
  "scan_failed",
  "$exception",
] as const;
const BUSINESS_EVENTS_SQL = `(${BUSINESS_EVENTS.map((e) => `'${e}'`).join(", ")})`;

// Count-card → feed drill-down. Clicking an overview count card re-loads the
// activity feed scoped to the rows BEHIND that number. The optional `event`
// filter param maps a FIXED allowlist value to a CONSTANT HogQL predicate
// fragment — never free text, never interpolated (RULE 4, HogQL safety). Each
// value corresponds to one overview count card.
export const ANALYTICS_EVENT_FILTERS = [
  "signup_completed",
  "login_completed",
  "card_added",
  "search_performed",
  "zero_result", // pseudo-value: search_performed AND results_count = 0
  "wishlist_added",
  "scan_started",
  "scan_succeeded",
  "$exception",
] as const;
export type AnalyticsEventFilter = (typeof ANALYTICS_EVENT_FILTERS)[number];

// allowlist value → constant HogQL predicate (the ONLY feed-filter text that
// reaches HogQL). `zero_result` is the only non-event pseudo-value.
const EVENT_FILTER_SQL: Record<AnalyticsEventFilter, string> = {
  signup_completed: "event = 'signup_completed'",
  login_completed: "event = 'login_completed'",
  card_added: "event = 'card_added'",
  search_performed: "event = 'search_performed'",
  zero_result: "event = 'search_performed' AND toFloat(properties.results_count) = 0",
  wishlist_added: "event = 'wishlist_added'",
  scan_started: "event = 'scan_started'",
  scan_succeeded: "event = 'scan_succeeded'",
  $exception: "event = '$exception'",
} as const;

// Per-feature DETAIL-ROW → feed drill-down. Clicking a label row in a
// per-feature list (a search term, a filter_type, a scan reason, an auth
// method) reveals the underlying events behind that row in the SAME activity
// feed. `dimension` is a FIXED allowlist mapped to a CONSTANT HogQL predicate
// fragment; the row's `value` is the ONLY dynamic part and is ALWAYS bound via
// the `{value}` placeholder (query.values), NEVER interpolated (RULE 4). For
// the categorical dimensions `value` is ALSO validated against a fixed enum
// (double-guarded). This generalizes the count-card `event` drill-down above.
export const ANALYTICS_DIMENSIONS = [
  "search_term", // search_performed for that exact query
  "zero_result_term", // search_performed + results_count=0 for that query
  "filter_type", // filter_applied for that filter_type (enum)
  "scan_reason", // scan_failed for that reason (enum)
  "signup_method", // signup_completed for that method (enum)
  "login_method", // login_completed for that method (enum)
] as const;
export type AnalyticsDimension = (typeof ANALYTICS_DIMENSIONS)[number];

// dimension → constant HogQL predicate fragment. The dynamic part is ONLY the
// `{value}` placeholder (supplied via query.values) — never concatenated text.
const DIMENSION_PREDICATE_SQL: Record<AnalyticsDimension, string> = {
  search_term: "event = 'search_performed' AND properties.query = {value}",
  zero_result_term:
    "event = 'search_performed' AND toFloat(properties.results_count) = 0 AND properties.query = {value}",
  filter_type: "event = 'filter_applied' AND properties.filter_type = {value}",
  scan_reason: "event = 'scan_failed' AND properties.reason = {value}",
  signup_method: "event = 'signup_completed' AND properties.method = {value}",
  login_method: "event = 'login_completed' AND properties.method = {value}",
} as const;

// Fixed value sets for the CATEGORICAL dimensions (docs/ANALYTICS_EVENTS.md).
// An absent key = a free-text dimension (search_term / zero_result_term) whose
// value is still placeholder-bound but not enum-restricted. Keeping these here
// (not just at the Zod boundary) keeps the allowlist in ONE place.
const DIMENSION_VALUE_ENUM: Partial<Record<AnalyticsDimension, readonly string[]>> = {
  filter_type: ["set", "rarity", "graded", "minPrice", "maxPrice", "hasPrice", "language", "sort"],
  scan_reason: ["not_recognized", "error"],
  signup_method: ["email", "google"],
  login_method: ["email", "google"],
} as const;

/**
 * True when `value` is acceptable for `dimension`: free-text dimensions accept
 * any non-empty value (still placeholder-bound), categorical dimensions accept
 * ONLY a value in their fixed enum. The route rejects a false here with 400 so
 * an off-list categorical value NEVER reaches PostHog (double-guard). Pure.
 */
export function isAllowedDimensionValue(dimension: AnalyticsDimension, value: string): boolean {
  const enumValues = DIMENSION_VALUE_ENUM[dimension];
  return enumValues ? enumValues.includes(value) : value.trim().length > 0;
}

// Row caps — bound the PostHog Query API cost and keep the page scannable.
const FEED_LIMIT = 100;
const LIST_LIMIT = 10;
// Distinct-persons drill-down (Unique Visitors): cap the identified list; the
// anonymous remainder is reported as a single honest count.
const PERSONS_LIMIT = 200;

export type AnalyticsMetrics = {
  uniqueVisitors: number | null;
  pageviews: number | null;
  signups: number | null;
  logins: number | null;
  cardsAdded: number | null;
  cardsAddedValueUsd: number | null;
  searches: number | null;
  zeroResultSearches: number | null;
  wishlistAdds: number | null;
  scansStarted: number | null;
  scansSucceeded: number | null;
  errors: number | null;
  // Distinct PERSONS (uniq(person_id), de-duped across sessions — NOT
  // uniq(distinct_id)). `distinctUsers` is the window-wide distinct person
  // count; dau/wau are fixed 24h/7d rolling windows regardless of `range`;
  // weeklyActiveCollectors = distinct persons with a card_added/card_removed
  // in the last 7 days. See audit items 1-2.
  distinctUsers: number | null;
  dau: number | null;
  wau: number | null;
  weeklyActiveCollectors: number | null;
};
export type AnalyticsDailyPoint = {
  date: string;
  pageviews: number | null;
  visitors: number | null;
};
export type AnalyticsFunnelStep = { label: string; users: number | null };
// ── Detail view shapes (the per-feature "who/when/which card/value" blocks) ──
export type ActivityRow = {
  time: string; // ISO timestamp
  email: string | null; // joined server-side via person; null → "anonymous"
  event: string; // raw event name
  detail: string | null; // the one salient prop for this event
  valueUsd: number | null;
  valueInr: number | null;
  environment: string | null;
  // Internal Better Auth user id resolved SERVER-SIDE from `email` (Prisma
  // lookup in the route) so the feed can link to /admin/users/[id]. Absent for
  // anonymous / deleted users (email with no matching row) → no link. The email
  // itself still comes only from the PostHog person join.
  userId?: string | null;
  // Human-readable catalog name for `detail` when it is a card_id, resolved
  // SERVER-SIDE from Card.externalId → Card.name (Prisma batch, route). Absent
  // when the row's detail is not a card id, or the id has no catalog match
  // (then the UI falls back to the raw id — honest, never fabricated).
  cardName?: string | null;
};
export type LabelCount = { label: string; count: number };
export type CardAgg = {
  cardId: string;
  count: number; // event count (or total quantity for card_added)
  valueUsd: number | null; // summed value_usd when relevant, else null
  // Catalog name (Card.externalId → Card.name), resolved server-side. Null when
  // the card has no catalog match → UI falls back to the raw id (RULE 2).
  cardName?: string | null;
};
export type SearchDetail = {
  topTerms: LabelCount[];
  zeroResult: LabelCount[]; // highest-value: unmet demand
  mostViewedCards: CardAgg[];
  filterTypes: LabelCount[];
  byGame: LabelCount[];
};
export type PortfolioDetail = {
  mostAdded: CardAgg[]; // card_added by card_id (qty + summed value)
  cardsRemoved: number | null;
  conditionSplit: LabelCount[]; // raw vs graded
  byGame: LabelCount[]; // pokemon vs one_piece
  chartRanges: LabelCount[]; // portfolio_chart_viewed range popularity
};
export type WishlistDetail = {
  mostWishlisted: CardAgg[];
  byGame: LabelCount[];
};
export type ScannerDetail = {
  started: number | null;
  succeeded: number | null;
  failed: number | null;
  successRate: number | null; // % of (succeeded / (succeeded+failed)), null if none
  failReasons: LabelCount[]; // not_recognized vs error
  byGame: LabelCount[];
};
export type AuthDetail = {
  signupsByMethod: LabelCount[]; // email vs google
  loginsByMethod: LabelCount[];
  onboardingCompleted: number | null;
  passwordResetRequested: number | null;
};
export type ErrorRow = { time: string; message: string | null; type: string | null };
export type EngagementDetail = {
  errorCount: number | null;
  recentErrors: ErrorRow[];
};
export type AnalyticsDetailData = {
  recentActivity: ActivityRow[];
  search: SearchDetail;
  portfolio: PortfolioDetail;
  wishlist: WishlistDetail;
  scanner: ScannerDetail;
  auth: AuthDetail;
  engagement: EngagementDetail;
};

export type AnalyticsData = {
  range: AnalyticsRange;
  environment: AnalyticsEnvironment;
  metrics: AnalyticsMetrics;
  topEvents: { event: string; count: number }[];
  daily: AnalyticsDailyPoint[];
  funnel: AnalyticsFunnelStep[];
  detail: AnalyticsDetailData;
  // Audit items 3-5 (honest states folded into the ok payload).
  retention: RetentionResult;
  signupCohorts: SignupCohortsResult;
  signupAttribution: SignupAttributionResult;
  fetchedAt: string;
};
// ── Retention / cohort / attribution shapes (audit items 3-5) ──────────────
/**
 * First-seen retention over the whole window: of the cohort of persons whose
 * FIRST business event was long enough ago to be observable at each bucket,
 * the % who returned (any business event) exactly D1 / D7 / D30 later. A null
 * (not a fabricated 0%) when the cohort is empty. `cohortSize` is the count of
 * anchored persons.
 */
export type RetentionData = {
  cohortSize: number | null;
  d1: number | null;
  d7: number | null;
  d30: number | null;
};
export type RetentionResult =
  | ({ status: "ok" } & RetentionData)
  | { status: "not_configured" }
  | { status: "unavailable" };

/**
 * Weekly signup-cohort retention: each row is a signup week (persons whose
 * signup_completed landed that week), the cohort `size`, and the % of them who
 * returned (any business event) in each following week. A zero-size week or a
 * not-yet-observable following week → null cell (UI "—"), never a fabricated 0.
 */
export type SignupCohortRow = {
  week: string; // ISO date of the week start (toStartOfWeek)
  size: number;
  returns: (number | null)[]; // following-week return %
};
export type SignupCohortsResult =
  | { status: "ok"; cohorts: SignupCohortRow[] }
  | { status: "not_configured" }
  | { status: "unavailable" };

/**
 * Signup conversion by initial-touch UTM (person props $initial_utm_source /
 * _medium / _campaign). Each list counts DISTINCT persons who completed signup,
 * bucketed by the attribution label; missing/blank UTM → "direct / none"
 * (never a blank or fabricated label). Supports Instagram, Comic Con QR,
 * direct and campaign attribution via whatever the initial-touch props carry.
 */
export type SignupAttributionResult =
  | { status: "ok"; bySource: LabelCount[]; byMedium: LabelCount[]; byCampaign: LabelCount[] }
  | { status: "not_configured" }
  | { status: "unavailable" };

export type AnalyticsResult =
  | ({ status: "ok" } & AnalyticsData)
  | { status: "not_configured" }
  | { status: "unavailable"; message: string };

// ── Drill-down shapes ──────────────────────────────────────────────────────
/** One behavioural event in the per-user feed (no email — the user is known). */
export type UserActivityEvent = {
  time: string; // ISO timestamp
  event: string;
  detail: string | null; // the one salient prop (card id / query / method / …)
  valueUsd: number | null;
  valueInr: number | null;
  environment: string | null;
};
export type UserActivityResult =
  | { status: "ok"; events: UserActivityEvent[] }
  | { status: "not_configured" }
  | { status: "unavailable" };

/** Per-card analytics aggregate for the admin drill-down popover. */
export type CardActivity = {
  viewed: number | null;
  added: number | null; // card_added event count
  addedQuantity: number | null; // summed quantity
  addedValueUsd: number | null; // summed value_usd
  wishlisted: number | null;
};
export type CardActivityResult =
  | ({ status: "ok"; cardId: string; range: AnalyticsRange; environment: AnalyticsEnvironment } & {
      activity: CardActivity;
    })
  | { status: "not_configured" }
  | { status: "unavailable" };

/**
 * Count-card drill-down feed: the activity rows BEHIND one overview count,
 * re-queried scoped to that metric's event (so the feed shows the TRUE rows,
 * not just whatever the default ~100-row feed happened to hold). Card names are
 * attached server-side in the route (same batch as the main feed).
 */
export type FilteredFeedResult =
  | {
      status: "ok";
      filter: AnalyticsEventFilter;
      range: AnalyticsRange;
      environment: AnalyticsEnvironment;
      rows: ActivityRow[];
    }
  | { status: "not_configured" }
  | { status: "unavailable" };

/**
 * Per-feature DETAIL-ROW drill-down feed: the activity rows BEHIND one label
 * row in a per-feature list (a search term, a filter_type, a scan reason, an
 * auth method), re-queried scoped to that `dimension`+`value`. Same
 * `ActivityRow[]` shape as the count-card feed, so the SAME mappers + client
 * `ActivityTable` are reused. Card names are attached server-side in the route.
 */
export type DimensionFeedResult =
  | {
      status: "ok";
      dimension: AnalyticsDimension;
      value: string;
      range: AnalyticsRange;
      environment: AnalyticsEnvironment;
      rows: ActivityRow[];
    }
  | { status: "not_configured" }
  | { status: "unavailable" };

/** One distinct identified person behind Unique Visitors (email + user link). */
export type DistinctPerson = { email: string; userId?: string | null };
/**
 * Distinct persons behind the Unique Visitors count: the identified ones by
 * email (linkable to their user page) plus the honest count of the anonymous
 * remainder (persons with no profile email). NEVER fabricates an identity.
 */
export type DistinctPersonsResult =
  | {
      status: "ok";
      range: AnalyticsRange;
      environment: AnalyticsEnvironment;
      identified: DistinctPerson[];
      anonymous: number; // distinct persons with no email (count only)
      total: number; // uniq(distinct_id) over the window
    }
  | { status: "not_configured" }
  | { status: "unavailable" };

// ── HogQL builders (pure) ────────────────────────────────────────────────
const where = (range: AnalyticsRange, env: AnalyticsEnvironment) =>
  `WHERE ${RANGE_SQL[range]} ${ENV_SQL[env]}`;

export function buildQueries(range: AnalyticsRange, env: AnalyticsEnvironment) {
  const w = where(range, env);
  return {
    totals:
      `SELECT uniq(distinct_id), countIf(event = '$pageview'), ` +
      `countIf(event = 'signup_completed'), countIf(event = 'login_completed'), ` +
      `countIf(event = 'card_added'), ` +
      `sumIf(toFloat(properties.value_usd), event = 'card_added'), ` +
      `countIf(event = 'search_performed'), ` +
      `countIf(event = 'search_performed' AND toFloat(properties.results_count) = 0), ` +
      `countIf(event = 'wishlist_added'), countIf(event = 'scan_started'), ` +
      `countIf(event = 'scan_succeeded'), countIf(event = '$exception'), ` +
      // Distinct PERSONS (de-duped across sessions): overall (window), DAU
      // (24h), WAU (7d), weekly active collectors (card_added/card_removed, 7d).
      // These use uniq(person_id), NOT uniq(distinct_id). The DAU/WAU/collector
      // windows are fixed rolling intervals (constant fragments), independent of
      // the selected range. Columns 12-15 (appended AFTER the existing 12).
      `uniq(person_id), ` +
      `uniqIf(person_id, timestamp >= now() - INTERVAL 24 HOUR), ` +
      `uniqIf(person_id, timestamp >= now() - INTERVAL 7 DAY), ` +
      `uniqIf(person_id, event IN ('card_added', 'card_removed') AND timestamp >= now() - INTERVAL 7 DAY) ` +
      `FROM events ${w}`,
    topEvents:
      `SELECT event, count() AS c FROM events ${w} ` +
      `GROUP BY event ORDER BY c DESC LIMIT 10`,
    daily:
      `SELECT toString(toDate(timestamp)) AS d, countIf(event = '$pageview'), ` +
      `uniq(distinct_id) FROM events ${w} GROUP BY d ORDER BY d`,
    // Unique users who reached each step in the window (not strictly ordered).
    funnel:
      `SELECT uniq(distinct_id), uniqIf(distinct_id, event = 'signup_started'), ` +
      `uniqIf(distinct_id, event = 'signup_completed'), ` +
      `uniqIf(distinct_id, event = 'card_added') FROM events ${w}`,
  };
}

// Business events EXCEPT '$exception' — the activity set that counts as
// "returned" for retention. An error is noise, not an intentional return, so it
// is excluded. CONSTANT SQL list literal; no user input ever reaches it.
const RETURN_EVENTS = BUSINESS_EVENTS.filter((e) => e !== "$exception");
const RETURN_EVENTS_SQL = `(${RETURN_EVENTS.map((e) => `'${e}'`).join(", ")})`;

/**
 * First-seen retention query (audit item 3). Anchors each person on their
 * first-EVER business-event day (min(toDate(timestamp)) over the return-event
 * set, GROUP BY person_id — NOT windowed, so the anchor is the true first
 * touch) and, in a subsequent self-join on the same person's return-event days,
 * counts how many returned EXACTLY 1 / 7 / 30 days later via
 * dateDiff('day', first_seen_day, activity_day). Only persons whose anchor is
 * old enough to be observable at a bucket are eligible for that bucket (the
 * cohortIf/returnIf pairs). ONE aggregate row:
 *   [cohortSize, d1cohort, d1ret, d7cohort, d7ret, d30cohort, d30ret]
 * Environment is the only variable part and is a CONSTANT allowlist fragment;
 * no user input is interpolated. Retention is a whole-population metric (the
 * range selector does not scope the anchor — that would truncate cohorts), so
 * no RANGE_SQL here by design.
 */
export function buildRetentionQuery(env: AnalyticsEnvironment) {
  const envFrag = ENV_SQL[env];
  // Per-person first-seen day + their set of return-event days.
  const firstSeen =
    `SELECT person_id, min(toDate(timestamp)) AS first_day ` +
    `FROM events WHERE event IN ${RETURN_EVENTS_SQL} ${envFrag} ` +
    `GROUP BY person_id`;
  const activity =
    `SELECT DISTINCT person_id, toDate(timestamp) AS act_day ` +
    `FROM events WHERE event IN ${RETURN_EVENTS_SQL} ${envFrag}`;
  // Join each person's first day to each of their later activity days. The
  // cohort for bucket N = persons whose first_day is >= N days before today
  // (so a return at N could have been observed); returned = any activity day
  // exactly N days after the first day.
  return (
    `SELECT ` +
    `uniq(f.person_id), ` +
    `uniqIf(f.person_id, f.first_day <= today() - 1), ` +
    `uniqIf(f.person_id, dateDiff('day', f.first_day, a.act_day) = 1), ` +
    `uniqIf(f.person_id, f.first_day <= today() - 7), ` +
    `uniqIf(f.person_id, dateDiff('day', f.first_day, a.act_day) = 7), ` +
    `uniqIf(f.person_id, f.first_day <= today() - 30), ` +
    `uniqIf(f.person_id, dateDiff('day', f.first_day, a.act_day) = 30) ` +
    `FROM (${firstSeen}) AS f LEFT JOIN (${activity}) AS a ON f.person_id = a.person_id`
  );
}

/**
 * Weekly signup-cohort retention query (audit item 4). Groups signup_completed
 * persons by their signup week (toStartOfWeek) and, per following-week offset
 * 1..4, counts DISTINCT persons from that cohort who had ANY return event in
 * that later week. ONE row per cohort week:
 *   [week, size, w1, w2, w3, w4]
 * Environment is the only variable part (CONSTANT allowlist fragment). Whole
 * population (no range scoping — a cohort table spans history by design).
 */
export function buildSignupCohortQuery(env: AnalyticsEnvironment) {
  const envFrag = ENV_SQL[env];
  const signups =
    `SELECT person_id, toStartOfWeek(min(timestamp)) AS cohort_week ` +
    `FROM events WHERE event = 'signup_completed' ${envFrag} ` +
    `GROUP BY person_id`;
  const activity =
    `SELECT DISTINCT person_id, toStartOfWeek(timestamp) AS act_week ` +
    `FROM events WHERE event IN ${RETURN_EVENTS_SQL} ${envFrag}`;
  // For each later-week offset, count persons whose activity week is exactly
  // N weeks after their cohort week (dateDiff in weeks).
  return (
    `SELECT toString(s.cohort_week), uniq(s.person_id), ` +
    `uniqIf(s.person_id, dateDiff('week', s.cohort_week, a.act_week) = 1), ` +
    `uniqIf(s.person_id, dateDiff('week', s.cohort_week, a.act_week) = 2), ` +
    `uniqIf(s.person_id, dateDiff('week', s.cohort_week, a.act_week) = 3), ` +
    `uniqIf(s.person_id, dateDiff('week', s.cohort_week, a.act_week) = 4) ` +
    `FROM (${signups}) AS s LEFT JOIN (${activity}) AS a ON s.person_id = a.person_id ` +
    `GROUP BY s.cohort_week ORDER BY s.cohort_week DESC LIMIT ${LIST_LIMIT}`
  );
}

/**
 * Signup conversion by initial-touch UTM (audit item 5). Three grouped queries
 * over person.properties.$initial_utm_source / _medium / _campaign counting
 * DISTINCT signup_completed persons per label — the SAME person-join mechanism
 * used to read email (never event props). range/env are CONSTANT allowlist
 * fragments. Blank/absent labels are kept (NOT filtered in SQL) so the mapper
 * can bucket them honestly as "direct / none" rather than silently dropping a
 * real signup.
 */
export function buildSignupAttributionQueries(range: AnalyticsRange, env: AnalyticsEnvironment) {
  const w = where(range, env);
  const grouped = (prop: string) =>
    `SELECT person.properties.${prop}, uniq(person_id) AS c FROM events ${w} ` +
    `AND event = 'signup_completed' GROUP BY person.properties.${prop} ORDER BY c DESC LIMIT ${LIST_LIMIT}`;
  return {
    bySource: grouped("$initial_utm_source"),
    byMedium: grouped("$initial_utm_medium"),
    byCampaign: grouped("$initial_utm_campaign"),
  };
}

/**
 * Per-feature DETAIL queries (the "who/when/which card/value" blocks). Same
 * fixed range/env fragments as buildQueries — NO user input is interpolated
 * (event lists, limits and column names are all compile-time constants). The
 * recent-activity query joins the PERSON to read `person.properties.email`
 * server-side; email is NEVER read from event properties (docs privacy note).
 */
export function buildDetailQueries(range: AnalyticsRange, env: AnalyticsEnvironment) {
  const w = where(range, env);
  return {
    // 1. RECENT ACTIVITY — latest business events, email via the person join.
    recentActivity:
      `SELECT timestamp, person.properties.email, event, ` +
      `properties.card_id, properties.query, properties.results_count, ` +
      `properties.filter_type, properties.method, properties.reason, ` +
      `properties.range, toFloat(properties.value_usd), toFloat(properties.value_inr), ` +
      `properties.environment ` +
      `FROM events ${w} AND event IN ${BUSINESS_EVENTS_SQL} ` +
      `ORDER BY timestamp DESC LIMIT ${FEED_LIMIT}`,

    // 2. SEARCH & DISCOVERY
    searchTerms:
      `SELECT properties.query, count() AS c FROM events ${w} ` +
      `AND event = 'search_performed' AND properties.query != '' ` +
      `GROUP BY properties.query ORDER BY c DESC LIMIT ${LIST_LIMIT}`,
    zeroResult:
      `SELECT properties.query, count() AS c FROM events ${w} ` +
      `AND event = 'search_performed' AND toFloat(properties.results_count) = 0 ` +
      `AND properties.query != '' ` +
      `GROUP BY properties.query ORDER BY c DESC LIMIT ${LIST_LIMIT}`,
    mostViewed:
      `SELECT properties.card_id, count() AS c FROM events ${w} ` +
      `AND event = 'card_viewed' AND properties.card_id != '' ` +
      `GROUP BY properties.card_id ORDER BY c DESC LIMIT ${LIST_LIMIT}`,
    filterTypes:
      `SELECT properties.filter_type, count() AS c FROM events ${w} ` +
      `AND event = 'filter_applied' AND properties.filter_type != '' ` +
      `GROUP BY properties.filter_type ORDER BY c DESC LIMIT ${LIST_LIMIT}`,
    searchByGame:
      `SELECT properties.game, count() AS c FROM events ${w} ` +
      `AND event = 'search_performed' AND properties.game != '' ` +
      `GROUP BY properties.game ORDER BY c DESC LIMIT ${LIST_LIMIT}`,

    // 3. PORTFOLIO / COLLECTION
    mostAdded:
      `SELECT properties.card_id, sum(toFloat(properties.quantity)) AS q, ` +
      `sum(toFloat(properties.value_usd)) AS v FROM events ${w} ` +
      `AND event = 'card_added' AND properties.card_id != '' ` +
      `GROUP BY properties.card_id ORDER BY q DESC LIMIT ${LIST_LIMIT}`,
    cardsRemoved:
      `SELECT count() FROM events ${w} AND event = 'card_removed'`,
    conditionSplit:
      `SELECT properties.condition, count() AS c FROM events ${w} ` +
      `AND event = 'card_added' AND properties.condition != '' ` +
      `GROUP BY properties.condition ORDER BY c DESC LIMIT ${LIST_LIMIT}`,
    portfolioByGame:
      `SELECT properties.game, count() AS c FROM events ${w} ` +
      `AND event = 'card_added' AND properties.game != '' ` +
      `GROUP BY properties.game ORDER BY c DESC LIMIT ${LIST_LIMIT}`,
    chartRanges:
      `SELECT properties.range, count() AS c FROM events ${w} ` +
      `AND event = 'portfolio_chart_viewed' AND properties.range != '' ` +
      `GROUP BY properties.range ORDER BY c DESC LIMIT ${LIST_LIMIT}`,

    // 4. WISHLIST
    mostWishlisted:
      `SELECT properties.card_id, count() AS c FROM events ${w} ` +
      `AND event = 'wishlist_added' AND properties.card_id != '' ` +
      `GROUP BY properties.card_id ORDER BY c DESC LIMIT ${LIST_LIMIT}`,
    wishlistByGame:
      `SELECT properties.game, count() AS c FROM events ${w} ` +
      `AND event = 'wishlist_added' AND properties.game != '' ` +
      `GROUP BY properties.game ORDER BY c DESC LIMIT ${LIST_LIMIT}`,

    // 5. SCANNER
    scanCounts:
      `SELECT countIf(event = 'scan_started'), countIf(event = 'scan_succeeded'), ` +
      `countIf(event = 'scan_failed') FROM events ${w}`,
    scanFailReasons:
      `SELECT properties.reason, count() AS c FROM events ${w} ` +
      `AND event = 'scan_failed' AND properties.reason != '' ` +
      `GROUP BY properties.reason ORDER BY c DESC LIMIT ${LIST_LIMIT}`,
    scanByGame:
      `SELECT properties.game, count() AS c FROM events ${w} ` +
      `AND event = 'scan_started' AND properties.game != '' ` +
      `GROUP BY properties.game ORDER BY c DESC LIMIT ${LIST_LIMIT}`,

    // 6. AUTH & ACTIVATION
    signupsByMethod:
      `SELECT properties.method, count() AS c FROM events ${w} ` +
      `AND event = 'signup_completed' AND properties.method != '' ` +
      `GROUP BY properties.method ORDER BY c DESC LIMIT ${LIST_LIMIT}`,
    loginsByMethod:
      `SELECT properties.method, count() AS c FROM events ${w} ` +
      `AND event = 'login_completed' AND properties.method != '' ` +
      `GROUP BY properties.method ORDER BY c DESC LIMIT ${LIST_LIMIT}`,
    activation:
      `SELECT countIf(event = 'onboarding_completed'), ` +
      `countIf(event = 'password_reset_requested') FROM events ${w}`,

    // 7. ENGAGEMENT / QUALITY — recent exceptions (message/type when present).
    recentErrors:
      `SELECT timestamp, properties.$exception_message, properties.$exception_type ` +
      `FROM events ${w} AND event = '$exception' ` +
      `ORDER BY timestamp DESC LIMIT ${LIST_LIMIT}`,
  };
}

// Row cap for the per-user behavioural feed on /admin/users/[id].
const USER_ACTIVITY_LIMIT = 25;

/**
 * Per-user behavioural feed (drill-down from the admin user detail page).
 * The email is the ONLY dynamic value and is bound via the `{email}`
 * placeholder (request body `query.values`) — NEVER string-interpolated. The
 * person join matches `person.properties.email = {email}`; business events only
 * (same BUSINESS_EVENTS_SQL constant list — autocapture/pageview noise out).
 */
export function buildUserActivityQuery(limit = USER_ACTIVITY_LIMIT) {
  const cap = Math.max(1, Math.min(100, Math.floor(limit)));
  return (
    `SELECT timestamp, event, properties.card_id, properties.query, ` +
    `properties.results_count, properties.filter_type, properties.method, ` +
    `properties.reason, properties.range, toFloat(properties.value_usd), ` +
    `toFloat(properties.value_inr), properties.environment ` +
    `FROM events WHERE person.properties.email = {email} ` +
    `AND event IN ${BUSINESS_EVENTS_SQL} ` +
    `ORDER BY timestamp DESC LIMIT ${cap}`
  );
}

/**
 * Per-card analytics aggregate (drill-down popover). The card_id (catalog
 * externalId) is the ONLY dynamic value, bound via the `{card_id}` placeholder
 * — NEVER interpolated. range/environment stay fixed allowlist fragments. One
 * row: [viewed, added, addedQty, addedValueUsd, wishlisted].
 */
export function buildCardActivityQuery(range: AnalyticsRange, env: AnalyticsEnvironment) {
  const w = where(range, env);
  return (
    `SELECT countIf(event = 'card_viewed'), countIf(event = 'card_added'), ` +
    `sumIf(toFloat(properties.quantity), event = 'card_added'), ` +
    `sumIf(toFloat(properties.value_usd), event = 'card_added'), ` +
    `countIf(event = 'wishlist_added') ` +
    `FROM events ${w} AND properties.card_id = {card_id}`
  );
}

/**
 * Count-card drill-down feed query: the same column layout as
 * buildDetailQueries.recentActivity (so the SAME mappers/UI apply) but scoped
 * to ONE metric via a FIXED allowlist predicate (`EVENT_FILTER_SQL[filter]`) —
 * the filter is a compile-time constant fragment, never free text, never
 * interpolated. range/environment stay the same fixed fragments. Capped at
 * FEED_LIMIT rows.
 */
export function buildFilteredFeedQuery(
  filter: AnalyticsEventFilter,
  range: AnalyticsRange,
  env: AnalyticsEnvironment
) {
  const w = where(range, env);
  return (
    `SELECT timestamp, person.properties.email, event, ` +
    `properties.card_id, properties.query, properties.results_count, ` +
    `properties.filter_type, properties.method, properties.reason, ` +
    `properties.range, toFloat(properties.value_usd), toFloat(properties.value_inr), ` +
    `properties.environment ` +
    `FROM events ${w} AND ${EVENT_FILTER_SQL[filter]} ` +
    `ORDER BY timestamp DESC LIMIT ${FEED_LIMIT}`
  );
}

/**
 * Per-feature DETAIL-ROW drill-down feed query: SAME column layout as
 * buildFilteredFeedQuery (so the SAME mappers/UI apply) but scoped to one
 * per-feature label row via a FIXED allowlist predicate
 * (`DIMENSION_PREDICATE_SQL[dimension]`) whose only dynamic part is the
 * `{value}` placeholder — the value is supplied via `query.values`, NEVER
 * interpolated into the string (RULE 4). range/environment stay the fixed
 * fragments. Capped at FEED_LIMIT rows.
 */
export function buildDimensionFeedQuery(
  dimension: AnalyticsDimension,
  range: AnalyticsRange,
  env: AnalyticsEnvironment
) {
  const w = where(range, env);
  return (
    `SELECT timestamp, person.properties.email, event, ` +
    `properties.card_id, properties.query, properties.results_count, ` +
    `properties.filter_type, properties.method, properties.reason, ` +
    `properties.range, toFloat(properties.value_usd), toFloat(properties.value_inr), ` +
    `properties.environment ` +
    `FROM events ${w} AND ${DIMENSION_PREDICATE_SQL[dimension]} ` +
    `ORDER BY timestamp DESC LIMIT ${FEED_LIMIT}`
  );
}

/**
 * Distinct-persons drill-down behind Unique Visitors: one DISTINCT person per
 * row with their profile email when known (null otherwise). range/environment
 * are the fixed fragments; no user input is interpolated. Capped at
 * PERSONS_LIMIT — the anonymous remainder is summed separately (see
 * buildDistinctPersonsCountQuery) so the UI never fabricates an identity.
 */
export function buildDistinctPersonsQuery(range: AnalyticsRange, env: AnalyticsEnvironment) {
  const w = where(range, env);
  return (
    `SELECT person.properties.email AS e, count() AS c FROM events ${w} ` +
    `GROUP BY e ORDER BY c DESC LIMIT ${PERSONS_LIMIT}`
  );
}

/**
 * Totals behind Unique Visitors: [distinct persons overall, distinct persons
 * with NO profile email]. Lets the UI show "identified (N) + anonymous (M)"
 * honestly without listing every anonymous person. Fixed fragments only.
 */
export function buildDistinctPersonsCountQuery(range: AnalyticsRange, env: AnalyticsEnvironment) {
  const w = where(range, env);
  return (
    `SELECT uniq(distinct_id), ` +
    `uniqIf(distinct_id, empty(toString(person.properties.email))) ` +
    `FROM events ${w}`
  );
}

// ── Response → metrics mapping (pure) ────────────────────────────────────
const RowsSchema = z.object({ results: z.array(z.array(z.unknown())) });

/** Finite number or null (PostHog returns null/NaN/strings for empty aggs). */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseRows(body: unknown): unknown[][] {
  const parsed = RowsSchema.safeParse(body);
  if (!parsed.success) throw new Error("Unexpected PostHog response shape");
  return parsed.data.results;
}

export function mapTotals(rows: unknown[][]): AnalyticsMetrics {
  const r = rows[0] ?? [];
  return {
    uniqueVisitors: num(r[0]),
    pageviews: num(r[1]),
    signups: num(r[2]),
    logins: num(r[3]),
    cardsAdded: num(r[4]),
    cardsAddedValueUsd: num(r[5]),
    searches: num(r[6]),
    zeroResultSearches: num(r[7]),
    wishlistAdds: num(r[8]),
    scansStarted: num(r[9]),
    scansSucceeded: num(r[10]),
    errors: num(r[11]),
    distinctUsers: num(r[12]),
    dau: num(r[13]),
    wau: num(r[14]),
    weeklyActiveCollectors: num(r[15]),
  };
}

export function mapTopEvents(rows: unknown[][]): AnalyticsData["topEvents"] {
  const out: AnalyticsData["topEvents"] = [];
  for (const r of rows) {
    const count = num(r[1]);
    if (typeof r[0] === "string" && count !== null) out.push({ event: r[0], count });
  }
  return out;
}

export function mapDaily(rows: unknown[][]): AnalyticsDailyPoint[] {
  const out: AnalyticsDailyPoint[] = [];
  for (const r of rows) {
    if (typeof r[0] === "string")
      out.push({ date: r[0], pageviews: num(r[1]), visitors: num(r[2]) });
  }
  return out;
}

export function mapFunnel(rows: unknown[][]): AnalyticsFunnelStep[] {
  const r = rows[0] ?? [];
  return [
    { label: "Visited", users: num(r[0]) },
    { label: "Signup started", users: num(r[1]) },
    { label: "Signup completed", users: num(r[2]) },
    { label: "Card added", users: num(r[3]) },
  ];
}

/** One retention bucket as a % of the cohort, rounded to 0.1. */
function pct(returned: number | null, cohort: number | null): number | null {
  if (cohort === null || cohort === 0 || returned === null) return null;
  return Math.round((returned / cohort) * 1000) / 10;
}

/**
 * Retention percentages from the buildRetentionQuery row. A zero/null cohort
 * for a bucket → null (UI "—"), never a fabricated 0% or 100%. Each bucket uses
 * its OWN observable cohort (people old enough to have reached that bucket).
 * `cohortSize` is the overall anchored-person count. Pure.
 */
export function retentionPercents(rows: unknown[][]): RetentionData {
  const r = rows[0] ?? [];
  // [cohortSize, d1cohort, d1ret, d7cohort, d7ret, d30cohort, d30ret]
  return {
    cohortSize: num(r[0]),
    d1: pct(num(r[2]), num(r[1])),
    d7: pct(num(r[4]), num(r[3])),
    d30: pct(num(r[6]), num(r[5])),
  };
}

/**
 * Shape the weekly signup-cohort rows. Each row:
 *   [week, size, w1, w2, w3, w4]
 * A zero-size week yields all-null return cells (never 0%/100%); otherwise each
 * following-week count becomes a % of the cohort size (null when PostHog gave
 * no value). Rows with no parseable week are dropped. Pure.
 */
export function shapeSignupCohorts(rows: unknown[][]): SignupCohortRow[] {
  const out: SignupCohortRow[] = [];
  for (const r of rows) {
    const week = str(r[0]);
    const size = num(r[1]);
    if (week === null) continue;
    const s = size ?? 0;
    const returns = [2, 3, 4, 5].map((i) => (s === 0 ? null : pct(num(r[i]), s)));
    out.push({ week, size: s, returns });
  }
  return out;
}

/**
 * Bucket grouped UTM rows into LabelCount[]. A blank/null label (no
 * initial-touch UTM) collapses into a single "direct / none" bucket — never a
 * blank label and never a fabricated source. Multiple blank variants (null, "",
 * whitespace) merge into the one direct bucket. Pure.
 */
export function bucketUtm(rows: unknown[][]): LabelCount[] {
  const DIRECT = "direct / none";
  let direct = 0;
  const byLabel = new Map<string, number>();
  for (const r of rows) {
    const label = str(r[0]);
    const count = num(r[1]);
    if (count === null) continue;
    if (label === null) {
      direct += count;
    } else {
      byLabel.set(label, (byLabel.get(label) ?? 0) + count);
    }
  }
  const out: LabelCount[] = Array.from(byLabel, ([label, count]) => ({ label, count }));
  if (direct > 0) out.push({ label: DIRECT, count: direct });
  // Keep the service's "highest first" convention.
  out.sort((a, b) => b.count - a.count);
  return out;
}

// ── Detail mappers (pure) ────────────────────────────────────────────────
/** Non-empty string or null (PostHog returns null/"" for absent props). */
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** `[label, count]` rows → LabelCount[], dropping rows with no label/count. */
export function mapLabelCounts(rows: unknown[][]): LabelCount[] {
  const out: LabelCount[] = [];
  for (const r of rows) {
    const label = str(r[0]);
    const count = num(r[1]);
    if (label !== null && count !== null) out.push({ label, count });
  }
  return out;
}

/**
 * `[cardId, count, valueUsd?]` rows → CardAgg[]. The 2nd column is the count
 * (or summed quantity); the optional 3rd is a summed value_usd.
 */
export function mapCardAgg(rows: unknown[][]): CardAgg[] {
  const out: CardAgg[] = [];
  for (const r of rows) {
    const cardId = str(r[0]);
    const count = num(r[1]);
    if (cardId !== null && count !== null)
      out.push({ cardId, count, valueUsd: r.length > 2 ? num(r[2]) : null });
  }
  return out;
}

/**
 * The ONE salient prop to show for an event, given the already-extracted
 * fields. Shared by the admin feed (activityDetail) and the per-user feed
 * (mapUserActivity) so both render the same friendly detail. Pure.
 */
export function salientDetail(fields: {
  event: string | null;
  cardId: string | null;
  query: string | null;
  resultsCount: number | null;
  filterType: string | null;
  method: string | null;
  reason: string | null;
  range: string | null;
}): string | null {
  const { event, cardId, query, resultsCount, filterType, method, reason, range } = fields;
  switch (event) {
    case "search_performed":
      return query === null
        ? null
        : `"${query}" · ${resultsCount ?? 0} result${resultsCount === 1 ? "" : "s"}`;
    case "filter_applied":
      return filterType;
    case "signup_started":
    case "signup_completed":
    case "login_completed":
      return method;
    case "scan_failed":
      return reason;
    case "portfolio_chart_viewed":
      return range;
    default:
      // card_added / card_removed / card_viewed / wishlist_added / scan_* → card id.
      return cardId;
  }
}

// recentActivity column order (buildDetailQueries.recentActivity):
// 0 timestamp, 1 email, 2 event, 3 card_id, 4 query, 5 results_count,
// 6 filter_type, 7 method, 8 reason, 9 range, 10 value_usd, 11 value_inr, 12 env
/** The ONE salient prop to show per event in the admin activity feed. Pure. */
export function activityDetail(r: unknown[]): string | null {
  return salientDetail({
    event: str(r[2]),
    cardId: str(r[3]),
    query: str(r[4]),
    resultsCount: num(r[5]),
    filterType: str(r[6]),
    method: str(r[7]),
    reason: str(r[8]),
    range: str(r[9]),
  });
}

/**
 * Attach the internal user id to each feed row from a pre-fetched email→id map
 * (the Prisma lookup lives in the route — this stays pure/testable). A row whose
 * email has no map entry (anonymous / deleted / email-less person) gets
 * `userId: null` → the UI renders plain text, no link. Pure.
 */
export function resolveFeedUserIds(
  rows: ActivityRow[],
  idByEmail: Map<string, string>
): ActivityRow[] {
  return rows.map((r) => ({
    ...r,
    userId: r.email ? (idByEmail.get(r.email) ?? null) : null,
  }));
}

// Feed events whose `detail` IS a card id (so `detail` can be resolved to a
// card name). Mirrors salientDetail's default branch. Exported so the client
// knows which Detail cells are card drill-downs.
export const CARD_DETAIL_EVENTS = [
  "card_added",
  "card_removed",
  "card_viewed",
  "wishlist_added",
  "scan_started",
  "scan_succeeded",
  "scan_failed",
] as const;
const CARD_DETAIL_EVENT_SET: ReadonlySet<string> = new Set(CARD_DETAIL_EVENTS);

/**
 * Attach the human-readable catalog name to each feed row whose `detail` is a
 * card id, from a pre-fetched externalId→name map (the Prisma batch lives in
 * the route — this stays pure/testable). A row whose detail is not a card id,
 * or whose id has no catalog match, gets `cardName: null` → the UI shows the
 * raw id (honest, RULE 2). Pure.
 */
export function attachFeedCardNames(
  rows: ActivityRow[],
  nameByExternalId: Map<string, string>
): ActivityRow[] {
  return rows.map((r) => {
    if (r.detail && CARD_DETAIL_EVENT_SET.has(r.event)) {
      return { ...r, cardName: nameByExternalId.get(r.detail) ?? null };
    }
    return { ...r, cardName: null };
  });
}

/** Attach catalog names to a CardAgg list (most-added/-viewed/-wishlisted). Pure. */
export function attachCardAggNames(
  rows: CardAgg[],
  nameByExternalId: Map<string, string>
): CardAgg[] {
  return rows.map((r) => ({ ...r, cardName: nameByExternalId.get(r.cardId) ?? null }));
}

/**
 * Collect every catalog externalId referenced by a feed + the card lists, so
 * the route can resolve names in ONE batched Prisma query (no N+1). Card-detail
 * feed rows contribute their `detail`; CardAgg rows contribute their `cardId`.
 * Pure — returns a de-duplicated id list.
 */
export function collectCardExternalIds(
  feeds: ActivityRow[][],
  cardLists: CardAgg[][]
): string[] {
  const ids = new Set<string>();
  for (const feed of feeds) {
    for (const r of feed) {
      if (r.detail && CARD_DETAIL_EVENT_SET.has(r.event)) ids.add(r.detail);
    }
  }
  for (const list of cardLists) {
    for (const r of list) ids.add(r.cardId);
  }
  return Array.from(ids);
}

export function mapRecentActivity(rows: unknown[][]): ActivityRow[] {
  const out: ActivityRow[] = [];
  for (const r of rows) {
    const time = str(r[0]);
    const event = str(r[2]);
    if (time === null || event === null) continue; // never a row we can't label
    out.push({
      time,
      email: str(r[1]), // null → UI renders "anonymous"
      event,
      detail: activityDetail(r),
      valueUsd: num(r[10]),
      valueInr: num(r[11]),
      environment: str(r[12]),
    });
  }
  return out;
}

export function mapScanner(countsRows: unknown[][], failRows: unknown[][], gameRows: unknown[][]): ScannerDetail {
  const c = countsRows[0] ?? [];
  const succeeded = num(c[1]);
  const failed = num(c[2]);
  // Success rate only when at least one scan resolved (succeeded+failed > 0).
  const resolved = (succeeded ?? 0) + (failed ?? 0);
  const successRate =
    succeeded === null && failed === null
      ? null
      : resolved === 0
        ? null
        : Math.round(((succeeded ?? 0) / resolved) * 1000) / 10;
  return {
    started: num(c[0]),
    succeeded,
    failed,
    successRate,
    failReasons: mapLabelCounts(failRows),
    byGame: mapLabelCounts(gameRows),
  };
}

export function mapRecentErrors(rows: unknown[][]): ErrorRow[] {
  const out: ErrorRow[] = [];
  for (const r of rows) {
    const time = str(r[0]);
    if (time === null) continue;
    out.push({ time, message: str(r[1]), type: str(r[2]) });
  }
  return out;
}

// buildUserActivityQuery column order:
// 0 timestamp, 1 event, 2 card_id, 3 query, 4 results_count, 5 filter_type,
// 6 method, 7 reason, 8 range, 9 value_usd, 10 value_inr, 11 env
/** Per-user behavioural feed rows → UserActivityEvent[]. Pure. */
export function mapUserActivity(rows: unknown[][]): UserActivityEvent[] {
  const out: UserActivityEvent[] = [];
  for (const r of rows) {
    const time = str(r[0]);
    const event = str(r[1]);
    if (time === null || event === null) continue; // never a row we can't label
    out.push({
      time,
      event,
      detail: salientDetail({
        event,
        cardId: str(r[2]),
        query: str(r[3]),
        resultsCount: num(r[4]),
        filterType: str(r[5]),
        method: str(r[6]),
        reason: str(r[7]),
        range: str(r[8]),
      }),
      valueUsd: num(r[9]),
      valueInr: num(r[10]),
      environment: str(r[11]),
    });
  }
  return out;
}

// buildCardActivityQuery single row: [viewed, added, addedQty, addedValueUsd, wishlisted]
/** Per-card aggregate row → CardActivity. Pure. */
export function mapCardActivity(rows: unknown[][]): CardActivity {
  const r = rows[0] ?? [];
  return {
    viewed: num(r[0]),
    added: num(r[1]),
    addedQuantity: num(r[2]),
    addedValueUsd: num(r[3]),
    wishlisted: num(r[4]),
  };
}

// buildDistinctPersonsQuery rows: [email|null, count]; countRows[0]: [total, anonymous]
/**
 * Distinct-persons result behind Unique Visitors. Identified persons (non-blank
 * email) are listed; the anonymous count comes from the authoritative
 * count query (distinct persons with no email), NOT from len() of a capped list
 * — so "anonymous (N)" stays honest even past PERSONS_LIMIT. Pure.
 */
export function mapDistinctPersons(
  personRows: unknown[][],
  countRows: unknown[][]
): { identified: DistinctPerson[]; anonymous: number; total: number } {
  const seen = new Set<string>();
  const identified: DistinctPerson[] = [];
  for (const r of personRows) {
    const email = str(r[0]);
    if (email !== null && !seen.has(email)) {
      seen.add(email);
      identified.push({ email });
    }
  }
  const c = countRows[0] ?? [];
  return {
    total: num(c[0]) ?? 0,
    anonymous: num(c[1]) ?? 0,
    identified,
  };
}

/**
 * Attach the internal user id to each identified person from a pre-fetched
 * email→id map (Prisma lookup in the route). No match (deleted) → userId null →
 * UI renders plain text. Pure.
 */
export function resolvePersonUserIds(
  persons: DistinctPerson[],
  idByEmail: Map<string, string>
): DistinctPerson[] {
  return persons.map((p) => ({ ...p, userId: idByEmail.get(p.email) ?? null }));
}

/**
 * Assemble the full detail block from the detail query result sets.
 * `errorCount` is the authoritative $exception total from the metrics query
 * (not the capped recent-errors list length).
 */
export function mapDetail(d: {
  errorCount: number | null;
  recentActivity: unknown[][];
  searchTerms: unknown[][];
  zeroResult: unknown[][];
  mostViewed: unknown[][];
  filterTypes: unknown[][];
  searchByGame: unknown[][];
  mostAdded: unknown[][];
  cardsRemoved: unknown[][];
  conditionSplit: unknown[][];
  portfolioByGame: unknown[][];
  chartRanges: unknown[][];
  mostWishlisted: unknown[][];
  wishlistByGame: unknown[][];
  scanCounts: unknown[][];
  scanFailReasons: unknown[][];
  scanByGame: unknown[][];
  signupsByMethod: unknown[][];
  loginsByMethod: unknown[][];
  activation: unknown[][];
  recentErrors: unknown[][];
}): AnalyticsDetailData {
  const act = d.activation[0] ?? [];
  return {
    recentActivity: mapRecentActivity(d.recentActivity),
    search: {
      topTerms: mapLabelCounts(d.searchTerms),
      zeroResult: mapLabelCounts(d.zeroResult),
      mostViewedCards: mapCardAgg(d.mostViewed),
      filterTypes: mapLabelCounts(d.filterTypes),
      byGame: mapLabelCounts(d.searchByGame),
    },
    portfolio: {
      mostAdded: mapCardAgg(d.mostAdded),
      cardsRemoved: num((d.cardsRemoved[0] ?? [])[0]),
      conditionSplit: mapLabelCounts(d.conditionSplit),
      byGame: mapLabelCounts(d.portfolioByGame),
      chartRanges: mapLabelCounts(d.chartRanges),
    },
    wishlist: {
      mostWishlisted: mapCardAgg(d.mostWishlisted),
      byGame: mapLabelCounts(d.wishlistByGame),
    },
    scanner: mapScanner(d.scanCounts, d.scanFailReasons, d.scanByGame),
    auth: {
      signupsByMethod: mapLabelCounts(d.signupsByMethod),
      loginsByMethod: mapLabelCounts(d.loginsByMethod),
      onboardingCompleted: num(act[0]),
      passwordResetRequested: num(act[1]),
    },
    engagement: {
      errorCount: d.errorCount,
      recentErrors: mapRecentErrors(d.recentErrors),
    },
  };
}

// ── Transport ────────────────────────────────────────────────────────────
function config() {
  const key = process.env.POSTHOG_PERSONAL_API_KEY?.trim();
  if (!key) return null;
  return {
    key,
    projectId: process.env.POSTHOG_PROJECT_ID?.trim() || "333915",
    host: (process.env.POSTHOG_API_HOST?.trim() || "https://eu.posthog.com").replace(/\/+$/, ""),
  };
}

/**
 * Run one HogQL query. When `values` is given, the SQL carries `{name}`
 * placeholders and the values go in the request body's `query.values` map —
 * PostHog substitutes them via its HogQL placeholder mechanism (ast.Placeholder),
 * so dynamic strings (user email, card id) are NEVER concatenated into SQL
 * (injection-safe, AGENTS.md RULE 4). The range/environment fragments stay
 * constant allowlist text; only email / card_id ever flow through `values`.
 */
async function hogql(
  cfg: NonNullable<ReturnType<typeof config>>,
  query: string,
  values?: Record<string, string>
): Promise<unknown[][]> {
  const res = await fetch(
    `${cfg.host}/api/projects/${encodeURIComponent(cfg.projectId)}/query/`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: { kind: "HogQLQuery", query, ...(values ? { values } : {}) },
      }),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    }
  );
  if (!res.ok) throw new Error(`PostHog responded ${res.status}`);
  return parseRows(await res.json());
}

// Cached payloads are re-parsed on read (RULE 4).
const LabelCountSchema = z.object({ label: z.string(), count: z.number() });
const CardAggSchema = z.object({
  cardId: z.string(),
  count: z.number(),
  valueUsd: z.number().nullable(),
});
// Audit items 3-5 cached sub-payloads — re-parsed on read (RULE 4). Each keeps
// its honest-state union (not_configured/unavailable fold in with their own
// shape so a cached "unavailable" survives a round-trip unchanged).
const RetentionCacheSchema = z.union([
  z.object({
    status: z.literal("ok"),
    cohortSize: z.number().nullable(),
    d1: z.number().nullable(),
    d7: z.number().nullable(),
    d30: z.number().nullable(),
  }),
  z.object({ status: z.literal("not_configured") }),
  z.object({ status: z.literal("unavailable") }),
]);
const SignupCohortsCacheSchema = z.union([
  z.object({
    status: z.literal("ok"),
    cohorts: z.array(
      z.object({
        week: z.string(),
        size: z.number(),
        returns: z.array(z.number().nullable()),
      })
    ),
  }),
  z.object({ status: z.literal("not_configured") }),
  z.object({ status: z.literal("unavailable") }),
]);
const SignupAttributionCacheSchema = z.union([
  z.object({
    status: z.literal("ok"),
    bySource: z.array(LabelCountSchema),
    byMedium: z.array(LabelCountSchema),
    byCampaign: z.array(LabelCountSchema),
  }),
  z.object({ status: z.literal("not_configured") }),
  z.object({ status: z.literal("unavailable") }),
]);

const CachedSchema = z.object({
  status: z.literal("ok"),
  range: z.enum(ANALYTICS_RANGES),
  environment: z.enum(ANALYTICS_ENVIRONMENTS),
  metrics: z.record(z.number().nullable()),
  topEvents: z.array(z.object({ event: z.string(), count: z.number() })),
  daily: z.array(
    z.object({
      date: z.string(),
      pageviews: z.number().nullable(),
      visitors: z.number().nullable(),
    })
  ),
  funnel: z.array(z.object({ label: z.string(), users: z.number().nullable() })),
  detail: z.object({
    recentActivity: z.array(
      z.object({
        time: z.string(),
        email: z.string().nullable(),
        event: z.string(),
        detail: z.string().nullable(),
        valueUsd: z.number().nullable(),
        valueInr: z.number().nullable(),
        environment: z.string().nullable(),
      })
    ),
    search: z.object({
      topTerms: z.array(LabelCountSchema),
      zeroResult: z.array(LabelCountSchema),
      mostViewedCards: z.array(CardAggSchema),
      filterTypes: z.array(LabelCountSchema),
      byGame: z.array(LabelCountSchema),
    }),
    portfolio: z.object({
      mostAdded: z.array(CardAggSchema),
      cardsRemoved: z.number().nullable(),
      conditionSplit: z.array(LabelCountSchema),
      byGame: z.array(LabelCountSchema),
      chartRanges: z.array(LabelCountSchema),
    }),
    wishlist: z.object({
      mostWishlisted: z.array(CardAggSchema),
      byGame: z.array(LabelCountSchema),
    }),
    scanner: z.object({
      started: z.number().nullable(),
      succeeded: z.number().nullable(),
      failed: z.number().nullable(),
      successRate: z.number().nullable(),
      failReasons: z.array(LabelCountSchema),
      byGame: z.array(LabelCountSchema),
    }),
    auth: z.object({
      signupsByMethod: z.array(LabelCountSchema),
      loginsByMethod: z.array(LabelCountSchema),
      onboardingCompleted: z.number().nullable(),
      passwordResetRequested: z.number().nullable(),
    }),
    engagement: z.object({
      errorCount: z.number().nullable(),
      recentErrors: z.array(
        z.object({
          time: z.string(),
          message: z.string().nullable(),
          type: z.string().nullable(),
        })
      ),
    }),
  }),
  retention: RetentionCacheSchema,
  signupCohorts: SignupCohortsCacheSchema,
  signupAttribution: SignupAttributionCacheSchema,
  fetchedAt: z.string(),
});

export async function getPosthogAnalytics(
  range: AnalyticsRange,
  environment: AnalyticsEnvironment
): Promise<AnalyticsResult> {
  const cfg = config();
  if (!cfg) return { status: "not_configured" };

  const cacheKey = RedisKeys.posthogAnalytics(range, environment);
  try {
    const raw = await redis.get(cacheKey);
    if (raw) {
      const parsed = CachedSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data as unknown as AnalyticsResult;
    }
  } catch {
    // Redis down / malformed → miss (RULE 1).
  }

  try {
    const q = buildQueries(range, environment);
    const dq = buildDetailQueries(range, environment);
    // One batched round-trip per metric group; row caps bound the cost.
    const [
      totals,
      top,
      daily,
      funnel,
      recentActivity,
      searchTerms,
      zeroResult,
      mostViewed,
      filterTypes,
      searchByGame,
      mostAdded,
      cardsRemoved,
      conditionSplit,
      portfolioByGame,
      chartRanges,
      mostWishlisted,
      wishlistByGame,
      scanCounts,
      scanFailReasons,
      scanByGame,
      signupsByMethod,
      loginsByMethod,
      activation,
      recentErrors,
    ] = await Promise.all([
      hogql(cfg, q.totals),
      hogql(cfg, q.topEvents),
      hogql(cfg, q.daily),
      hogql(cfg, q.funnel),
      hogql(cfg, dq.recentActivity),
      hogql(cfg, dq.searchTerms),
      hogql(cfg, dq.zeroResult),
      hogql(cfg, dq.mostViewed),
      hogql(cfg, dq.filterTypes),
      hogql(cfg, dq.searchByGame),
      hogql(cfg, dq.mostAdded),
      hogql(cfg, dq.cardsRemoved),
      hogql(cfg, dq.conditionSplit),
      hogql(cfg, dq.portfolioByGame),
      hogql(cfg, dq.chartRanges),
      hogql(cfg, dq.mostWishlisted),
      hogql(cfg, dq.wishlistByGame),
      hogql(cfg, dq.scanCounts),
      hogql(cfg, dq.scanFailReasons),
      hogql(cfg, dq.scanByGame),
      hogql(cfg, dq.signupsByMethod),
      hogql(cfg, dq.loginsByMethod),
      hogql(cfg, dq.activation),
      hogql(cfg, dq.recentErrors),
    ]);
    // Audit items 3-5 in the SAME batch (each a standalone honest-state
    // service so a single-block PostHog hiccup degrades that block to
    // `unavailable` without failing the whole dashboard).
    const [retention, signupCohorts, signupAttribution] = await Promise.all([
      getRetention(environment),
      getSignupCohorts(environment),
      getSignupAttribution(range, environment),
    ]);
    const metrics = mapTotals(totals);
    const result: AnalyticsResult = {
      status: "ok",
      range,
      environment,
      metrics,
      topEvents: mapTopEvents(top),
      daily: mapDaily(daily),
      funnel: mapFunnel(funnel),
      detail: mapDetail({
        errorCount: metrics.errors,
        recentActivity,
        searchTerms,
        zeroResult,
        mostViewed,
        filterTypes,
        searchByGame,
        mostAdded,
        cardsRemoved,
        conditionSplit,
        portfolioByGame,
        chartRanges,
        mostWishlisted,
        wishlistByGame,
        scanCounts,
        scanFailReasons,
        scanByGame,
        signupsByMethod,
        loginsByMethod,
        activation,
        recentErrors,
      }),
      retention,
      signupCohorts,
      signupAttribution,
      fetchedAt: new Date().toISOString(),
    };
    try {
      await redis.set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL.posthogAnalytics);
    } catch {
      // cache-only (RULE 1)
    }
    return result;
  } catch (err) {
    // Log status/shape only — the message never contains the key.
    console.error("[posthog-query] failed:", err instanceof Error ? err.message : err);
    return { status: "unavailable", message: "PostHog unavailable" };
  }
}

/**
 * First-seen retention (D1/D7/D30) — audit item 3. Standalone honest-state
 * wrapper around buildRetentionQuery + retentionPercents. Not cached on its
 * own (it is folded into getPosthogAnalytics' ~90s cache). unset key →
 * not_configured (no request); PostHog error → unavailable; empty cohort →
 * null percentages. Never throws.
 */
export async function getRetention(environment: AnalyticsEnvironment): Promise<RetentionResult> {
  const cfg = config();
  if (!cfg) return { status: "not_configured" };
  try {
    const rows = await hogql(cfg, buildRetentionQuery(environment));
    const d = retentionPercents(rows);
    return { status: "ok", ...d };
  } catch (err) {
    console.error("[posthog-query] retention failed:", err instanceof Error ? err.message : err);
    return { status: "unavailable" };
  }
}

/**
 * Weekly signup-cohort retention — audit item 4. Honest-state wrapper around
 * buildSignupCohortQuery + shapeSignupCohorts. Honest states as elsewhere; a
 * fully-empty result → ok with no cohort rows. Never throws.
 */
export async function getSignupCohorts(
  environment: AnalyticsEnvironment
): Promise<SignupCohortsResult> {
  const cfg = config();
  if (!cfg) return { status: "not_configured" };
  try {
    const rows = await hogql(cfg, buildSignupCohortQuery(environment));
    return { status: "ok", cohorts: shapeSignupCohorts(rows) };
  } catch (err) {
    console.error("[posthog-query] signup cohorts failed:", err instanceof Error ? err.message : err);
    return { status: "unavailable" };
  }
}

/**
 * Signup conversion by initial-touch UTM (source/medium/campaign) — audit item
 * 5. Three grouped person-prop queries → bucketUtm (missing → "direct / none").
 * Honest states as elsewhere. Never throws.
 */
export async function getSignupAttribution(
  range: AnalyticsRange,
  environment: AnalyticsEnvironment
): Promise<SignupAttributionResult> {
  const cfg = config();
  if (!cfg) return { status: "not_configured" };
  try {
    const q = buildSignupAttributionQueries(range, environment);
    const [bySource, byMedium, byCampaign] = await Promise.all([
      hogql(cfg, q.bySource),
      hogql(cfg, q.byMedium),
      hogql(cfg, q.byCampaign),
    ]);
    return {
      status: "ok",
      bySource: bucketUtm(bySource),
      byMedium: bucketUtm(byMedium),
      byCampaign: bucketUtm(byCampaign),
    };
  } catch (err) {
    console.error("[posthog-query] signup attribution failed:", err instanceof Error ? err.message : err);
    return { status: "unavailable" };
  }
}

/**
 * Per-user behavioural activity feed for /admin/users/[id] (drill-down from the
 * admin analytics). Runs one allowlist-safe HogQL query filtered to this
 * person's events; the email is bound via the `{email}` placeholder (never
 * interpolated). Honest states: unset key → not_configured; PostHog error →
 * unavailable (the page falls back to DB account facts); zero events → ok with
 * an empty list. Never throws. Not cached: the detail page is per-request SSR
 * and a per-email cache would pile keys for little gain.
 */
export async function getUserActivity(
  email: string,
  opts: { limit?: number } = {}
): Promise<UserActivityResult> {
  const cfg = config();
  if (!cfg) return { status: "not_configured" };
  const trimmed = email.trim();
  if (!trimmed) return { status: "ok", events: [] };
  try {
    const rows = await hogql(cfg, buildUserActivityQuery(opts.limit), { email: trimmed });
    return { status: "ok", events: mapUserActivity(rows) };
  } catch (err) {
    console.error("[posthog-query] user activity failed:", err instanceof Error ? err.message : err);
    return { status: "unavailable" };
  }
}

// Cached card-activity payload is re-parsed on read (RULE 4).
const CardActivityCacheSchema = z.object({
  status: z.literal("ok"),
  cardId: z.string(),
  range: z.enum(ANALYTICS_RANGES),
  environment: z.enum(ANALYTICS_ENVIRONMENTS),
  activity: z.object({
    viewed: z.number().nullable(),
    added: z.number().nullable(),
    addedQuantity: z.number().nullable(),
    addedValueUsd: z.number().nullable(),
    wishlisted: z.number().nullable(),
  }),
});

/**
 * Per-card analytics aggregate for the admin drill-down popover (times viewed /
 * added + qty + summed value / wishlisted) over the selected range+environment.
 * The card_id is bound via the `{card_id}` placeholder (never interpolated).
 * Row-capped (single aggregate row) and Redis-cached ~90s (optional, RULE 1).
 * Honest states: unset key → not_configured; PostHog error → unavailable; no
 * events → ok with all-null/zero aggregates. Never throws.
 */
export async function getCardActivity(
  cardId: string,
  range: AnalyticsRange,
  environment: AnalyticsEnvironment
): Promise<CardActivityResult> {
  const cfg = config();
  if (!cfg) return { status: "not_configured" };
  const trimmed = cardId.trim();
  if (!trimmed) return { status: "unavailable" };

  const cacheKey = RedisKeys.posthogCardActivity(trimmed, range, environment);
  try {
    const raw = await redis.get(cacheKey);
    if (raw) {
      const parsed = CardActivityCacheSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data as CardActivityResult;
    }
  } catch {
    // Redis down / malformed → miss (RULE 1).
  }

  try {
    const rows = await hogql(cfg, buildCardActivityQuery(range, environment), {
      card_id: trimmed,
    });
    const result: CardActivityResult = {
      status: "ok",
      cardId: trimmed,
      range,
      environment,
      activity: mapCardActivity(rows),
    };
    try {
      await redis.set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL.posthogAnalytics);
    } catch {
      // cache-only (RULE 1)
    }
    return result;
  } catch (err) {
    console.error("[posthog-query] card activity failed:", err instanceof Error ? err.message : err);
    return { status: "unavailable" };
  }
}

// Cached feed payload is re-parsed on read (RULE 4).
const FeedRowSchema = z.object({
  time: z.string(),
  email: z.string().nullable(),
  event: z.string(),
  detail: z.string().nullable(),
  valueUsd: z.number().nullable(),
  valueInr: z.number().nullable(),
  environment: z.string().nullable(),
});
const FeedCacheSchema = z.object({
  status: z.literal("ok"),
  filter: z.enum(ANALYTICS_EVENT_FILTERS),
  range: z.enum(ANALYTICS_RANGES),
  environment: z.enum(ANALYTICS_ENVIRONMENTS),
  rows: z.array(FeedRowSchema),
});

/**
 * Count-card drill-down feed: re-query the activity feed scoped to ONE overview
 * metric's event (the rows behind that number), so the feed is COMPLETE for the
 * metric rather than limited to whatever the default feed held. `filter` is a
 * FIXED allowlist value mapped to a constant HogQL predicate (never free text,
 * never interpolated). Row-capped (FEED_LIMIT) + Redis-cached ~90s (optional,
 * RULE 1). Card names are attached later in the route (same batch as the main
 * feed). Honest states: unset key → not_configured; PostHog error →
 * unavailable. Never throws.
 */
export async function getFilteredFeed(
  filter: AnalyticsEventFilter,
  range: AnalyticsRange,
  environment: AnalyticsEnvironment
): Promise<FilteredFeedResult> {
  const cfg = config();
  if (!cfg) return { status: "not_configured" };

  const cacheKey = RedisKeys.posthogFeed(filter, range, environment);
  try {
    const raw = await redis.get(cacheKey);
    if (raw) {
      const parsed = FeedCacheSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data as FilteredFeedResult;
    }
  } catch {
    // Redis down / malformed → miss (RULE 1).
  }

  try {
    const rows = mapRecentActivity(await hogql(cfg, buildFilteredFeedQuery(filter, range, environment)));
    const result: FilteredFeedResult = { status: "ok", filter, range, environment, rows };
    try {
      await redis.set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL.posthogAnalytics);
    } catch {
      // cache-only (RULE 1)
    }
    return result;
  } catch (err) {
    console.error("[posthog-query] filtered feed failed:", err instanceof Error ? err.message : err);
    return { status: "unavailable" };
  }
}

// Cached distinct-persons payload is re-parsed on read (RULE 4).
const PersonsCacheSchema = z.object({
  status: z.literal("ok"),
  range: z.enum(ANALYTICS_RANGES),
  environment: z.enum(ANALYTICS_ENVIRONMENTS),
  identified: z.array(z.object({ email: z.string() })),
  anonymous: z.number(),
  total: z.number(),
});

/**
 * Distinct-persons drill-down behind Unique Visitors: the identified persons by
 * email plus the honest anonymous remainder count (NEVER a fabricated
 * identity). Two fixed-fragment queries (the ranked list + the authoritative
 * total/anonymous counts). Row-capped (PERSONS_LIMIT) + Redis-cached ~90s
 * (optional, RULE 1). The email → user id resolution happens in the route
 * (Prisma batch). Honest states as elsewhere. Never throws.
 */
export async function getDistinctPersons(
  range: AnalyticsRange,
  environment: AnalyticsEnvironment
): Promise<DistinctPersonsResult> {
  const cfg = config();
  if (!cfg) return { status: "not_configured" };

  const cacheKey = RedisKeys.posthogPersons(range, environment);
  try {
    const raw = await redis.get(cacheKey);
    if (raw) {
      const parsed = PersonsCacheSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data as DistinctPersonsResult;
    }
  } catch {
    // Redis down / malformed → miss (RULE 1).
  }

  try {
    const [personRows, countRows] = await Promise.all([
      hogql(cfg, buildDistinctPersonsQuery(range, environment)),
      hogql(cfg, buildDistinctPersonsCountQuery(range, environment)),
    ]);
    const mapped = mapDistinctPersons(personRows, countRows);
    const result: DistinctPersonsResult = {
      status: "ok",
      range,
      environment,
      identified: mapped.identified,
      anonymous: mapped.anonymous,
      total: mapped.total,
    };
    try {
      await redis.set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL.posthogAnalytics);
    } catch {
      // cache-only (RULE 1)
    }
    return result;
  } catch (err) {
    console.error("[posthog-query] distinct persons failed:", err instanceof Error ? err.message : err);
    return { status: "unavailable" };
  }
}

// Cached dimension-feed payload is re-parsed on read (RULE 4).
const DimensionFeedCacheSchema = z.object({
  status: z.literal("ok"),
  dimension: z.enum(ANALYTICS_DIMENSIONS),
  value: z.string(),
  range: z.enum(ANALYTICS_RANGES),
  environment: z.enum(ANALYTICS_ENVIRONMENTS),
  rows: z.array(FeedRowSchema),
});

/**
 * Per-feature DETAIL-ROW drill-down feed: re-query the activity feed scoped to
 * ONE per-feature label row (a search term / zero-result term / filter_type /
 * scan reason / auth method). `dimension` is a FIXED allowlist value mapped to
 * a constant HogQL predicate; `value` is the ONLY dynamic part and is bound via
 * the `{value}` placeholder (never interpolated, RULE 4). Row-capped
 * (FEED_LIMIT) + Redis-cached ~90s (optional, RULE 1). Card names are attached
 * later in the route (same batch as the main feed). Honest states: unset key →
 * not_configured; blank value → ok with no rows (no request); PostHog error →
 * unavailable. Never throws. (Categorical-value allowlisting happens at the
 * route boundary via isAllowedDimensionValue, so an off-list categorical value
 * never reaches this function.)
 */
export async function getDimensionFeed(
  dimension: AnalyticsDimension,
  value: string,
  range: AnalyticsRange,
  environment: AnalyticsEnvironment
): Promise<DimensionFeedResult> {
  const cfg = config();
  if (!cfg) return { status: "not_configured" };
  const trimmed = value.trim();
  if (!trimmed) return { status: "ok", dimension, value: trimmed, range, environment, rows: [] };

  const cacheKey = RedisKeys.posthogDimensionFeed(dimension, trimmed, range, environment);
  try {
    const raw = await redis.get(cacheKey);
    if (raw) {
      const parsed = DimensionFeedCacheSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data as DimensionFeedResult;
    }
  } catch {
    // Redis down / malformed → miss (RULE 1).
  }

  try {
    const rows = mapRecentActivity(
      await hogql(cfg, buildDimensionFeedQuery(dimension, range, environment), { value: trimmed })
    );
    const result: DimensionFeedResult = {
      status: "ok",
      dimension,
      value: trimmed,
      range,
      environment,
      rows,
    };
    try {
      await redis.set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL.posthogAnalytics);
    } catch {
      // cache-only (RULE 1)
    }
    return result;
  } catch (err) {
    console.error("[posthog-query] dimension feed failed:", err instanceof Error ? err.message : err);
    return { status: "unavailable" };
  }
}
