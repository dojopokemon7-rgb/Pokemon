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

// Row caps — bound the PostHog Query API cost and keep the page scannable.
const FEED_LIMIT = 100;
const LIST_LIMIT = 10;

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
};
export type LabelCount = { label: string; count: number };
export type CardAgg = {
  cardId: string;
  count: number; // event count (or total quantity for card_added)
  valueUsd: number | null; // summed value_usd when relevant, else null
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
  fetchedAt: string;
};
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
      `countIf(event = 'scan_succeeded'), countIf(event = '$exception') ` +
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
