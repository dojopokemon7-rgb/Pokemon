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
export type AnalyticsData = {
  range: AnalyticsRange;
  environment: AnalyticsEnvironment;
  metrics: AnalyticsMetrics;
  topEvents: { event: string; count: number }[];
  daily: AnalyticsDailyPoint[];
  funnel: AnalyticsFunnelStep[];
  fetchedAt: string;
};
export type AnalyticsResult =
  | ({ status: "ok" } & AnalyticsData)
  | { status: "not_configured" }
  | { status: "unavailable"; message: string };

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

async function hogql(
  cfg: NonNullable<ReturnType<typeof config>>,
  query: string
): Promise<unknown[][]> {
  const res = await fetch(
    `${cfg.host}/api/projects/${encodeURIComponent(cfg.projectId)}/query/`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    }
  );
  if (!res.ok) throw new Error(`PostHog responded ${res.status}`);
  return parseRows(await res.json());
}

// Cached payloads are re-parsed on read (RULE 4).
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
    const [totals, top, daily, funnel] = await Promise.all([
      hogql(cfg, q.totals),
      hogql(cfg, q.topEvents),
      hogql(cfg, q.daily),
      hogql(cfg, q.funnel),
    ]);
    const result: AnalyticsResult = {
      status: "ok",
      range,
      environment,
      metrics: mapTotals(totals),
      topEvents: mapTopEvents(top),
      daily: mapDaily(daily),
      funnel: mapFunnel(funnel),
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
