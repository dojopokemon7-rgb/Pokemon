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
import { prisma } from "@/lib/db";
import {
  ANALYTICS_RANGES,
  ANALYTICS_ENVIRONMENTS,
  getPosthogAnalytics,
  resolveFeedUserIds,
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

  // DRILL-DOWN: resolve each feed row's PostHog person email → internal Better
  // Auth user id (one batched Prisma lookup) so the client can link the User
  // cell to /admin/users/[id]. The email still comes ONLY from the person join
  // (service); an unmatched email (anonymous / deleted) stays unlinked. Prisma
  // failure is swallowed — the feed renders unlinked, never 5xx.
  if (result.status === "ok" && result.detail.recentActivity.length > 0) {
    const emails = result.detail.recentActivity
      .map((r) => r.email)
      .filter((e): e is string => typeof e === "string" && e.length > 0);
    let idByEmail: Map<string, string> = new Map();
    if (emails.length > 0) {
      try {
        const rows = await prisma.user.findMany({
          where: { email: { in: Array.from(new Set(emails)) } },
          select: { id: true, email: true },
        });
        idByEmail = new Map(rows.map((u) => [u.email, u.id]));
      } catch {
        // Fall through unlinked (RULE 1-style graceful degradation).
      }
    }
    result.detail.recentActivity = resolveFeedUserIds(result.detail.recentActivity, idByEmail);
  }

  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
