/**
 * GET /api/admin/analytics/card?cardId=<externalId>&range=24h|7d|30d&environment=production|staging|all
 *
 * Admin-only (requireAdmin → isolated admin session cookie, 401 otherwise).
 * Backs the card drill-down popover on /admin/analytics: a per-card PostHog
 * aggregate (times viewed / added + qty + summed USD / wishlisted) over the
 * selected range+environment. Defaults: range=7d, environment=production.
 * Missing/invalid params → 400.
 *
 * `cardId` is the ONLY dynamic value and is bound via a HogQL `{card_id}`
 * placeholder inside the service (never string-interpolated, RULE 4). The
 * PostHog key stays server-side; unconfigured / PostHog failure returns HTTP
 * 200 `{ status: "not_configured" | "unavailable" }` (honest, never fabricated).
 * Row-capped (single aggregate row) and Redis-cached ~90s in the service.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/utils/auth-guard";
import {
  ANALYTICS_RANGES,
  ANALYTICS_ENVIRONMENTS,
  getCardActivity,
} from "@/lib/services/posthog-query.service";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  cardId: z.string().trim().min(1).max(100),
  range: z.enum(ANALYTICS_RANGES).default("7d"),
  environment: z.enum(ANALYTICS_ENVIRONMENTS).default("production"),
});

export async function GET(request: Request): Promise<NextResponse> {
  const guard = await requireAdmin(request);
  if (guard.unauthorized) return guard.unauthorized;

  const sp = new URL(request.url).searchParams;
  const parsed = QuerySchema.safeParse({
    cardId: sp.get("cardId") ?? undefined,
    range: sp.get("range") ?? undefined,
    environment: sp.get("environment") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query parameters" }, { status: 400 });
  }

  const result = await getCardActivity(
    parsed.data.cardId,
    parsed.data.range,
    parsed.data.environment
  );
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
