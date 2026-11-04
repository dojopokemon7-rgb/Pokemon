/**
 * GET /api/admin/analytics?range=24h|7d|30d&environment=production|staging|all
 *
 * Admin-only (requireAdmin → isolated admin session cookie, 401 otherwise).
 * Returns PostHog product-analytics aggregates for the in-app admin dashboard.
 * Defaults: range=7d, environment=production. Invalid params → 400.
 *
 * The PostHog personal API key stays server-side. Unconfigured / PostHog
 * failure is returned as HTTP 200 `{ status: "not_configured" | "unavailable" }`
 * (honest empty state, never fabricated numbers). Results are Redis-cached ~90s
 * inside the service (optional cache, RULE 1).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/utils/auth-guard";
import {
  ANALYTICS_RANGES,
  ANALYTICS_ENVIRONMENTS,
  getPosthogAnalytics,
} from "@/lib/services/posthog-query.service";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  range: z.enum(ANALYTICS_RANGES).default("7d"),
  environment: z.enum(ANALYTICS_ENVIRONMENTS).default("production"),
});

export async function GET(request: Request): Promise<NextResponse> {
  const guard = await requireAdmin(request);
  if (guard.unauthorized) return guard.unauthorized;

  const sp = new URL(request.url).searchParams;
  const parsed = QuerySchema.safeParse({
    range: sp.get("range") ?? undefined,
    environment: sp.get("environment") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query parameters" }, { status: 400 });
  }

  const result = await getPosthogAnalytics(parsed.data.range, parsed.data.environment);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
