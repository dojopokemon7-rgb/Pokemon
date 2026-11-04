/**
 * GET /api/admin/analytics?range=24h|7d|30d&environment=production|staging|all
 *     [&event=<allowlisted metric>] [&view=persons]
 *
 * Admin-only (requireAdmin → isolated admin session cookie, 401 otherwise).
 * Returns PostHog product-analytics aggregates for the in-app admin dashboard.
 * Defaults: range=7d, environment=production. Invalid params → 400.
 *
 * DRILL-DOWN modes (the "who/what behind every count" feature):
 *  - `event=<allowlisted>`: re-load JUST the activity rows behind one overview
 *    count card (login_completed, card_added, search_performed, zero_result,
 *    wishlist_added, scan_*, signup_completed, $exception). The value is
 *    Zod-validated against a FIXED allowlist and mapped (in the service) to a
 *    constant HogQL predicate — never free text, never interpolated.
 *  - `view=persons`: the DISTINCT persons behind Unique Visitors — identified
 *    by email (with a user link) + an honest anonymous remainder count.
 * Both reuse the same card-name + email→user-id server-side resolution as the
 * default view.
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
  ANALYTICS_EVENT_FILTERS,
  getPosthogAnalytics,
  getFilteredFeed,
  getDistinctPersons,
  resolveFeedUserIds,
  resolvePersonUserIds,
  attachFeedCardNames,
  attachCardAggNames,
  collectCardExternalIds,
} from "@/lib/services/posthog-query.service";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  range: z.enum(ANALYTICS_RANGES).default("7d"),
  environment: z.enum(ANALYTICS_ENVIRONMENTS).default("production"),
  // Optional count-card drill-down. FIXED allowlist only (never free text); an
  // out-of-allowlist value fails parse → 400. Absent → the full dashboard.
  event: z.enum(ANALYTICS_EVENT_FILTERS).optional(),
  view: z.literal("persons").optional(),
});

/**
 * Batch-resolve PostHog person emails → internal Better Auth user ids (one
 * Prisma query). Swallows failure → unlinked (RULE 1-style graceful
 * degradation). The email itself still comes ONLY from the PostHog person join.
 */
async function emailToUserId(emails: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(emails.filter((e) => e.length > 0)));
  if (unique.length === 0) return new Map();
  try {
    const rows = await prisma.user.findMany({
      where: { email: { in: unique } },
      select: { id: true, email: true },
    });
    return new Map(rows.map((u) => [u.email, u.id]));
  } catch {
    return new Map();
  }
}

/**
 * Batch-resolve catalog externalIds → card names (one Prisma query, no N+1).
 * RULE 3: the analytics card_id is the catalog `externalId`, never the internal
 * cuid. Composite per-printing ids (`baseId::variant`) are split on `::` first
 * so a printing row still resolves to the base card's name. Unknown id → absent
 * from the map → UI falls back to the raw id (RULE 2). Failure → empty map.
 */
async function externalIdToName(externalIds: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(externalIds.filter((id) => id.length > 0)));
  if (unique.length === 0) return new Map();
  // Query by the BASE id (split composite printing ids), then map names back to
  // every original id that shares that base.
  const baseOf = (id: string) => id.split("::")[0];
  const baseIds = Array.from(new Set(unique.map(baseOf)));
  try {
    const rows = await prisma.card.findMany({
      where: { externalId: { in: baseIds } },
      select: { externalId: true, name: true },
    });
    const nameByBase = new Map(rows.map((c) => [c.externalId, c.name]));
    const out = new Map<string, string>();
    for (const id of unique) {
      const name = nameByBase.get(baseOf(id));
      if (name) out.set(id, name);
    }
    return out;
  } catch {
    return new Map();
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const guard = await requireAdmin(request);
  if (guard.unauthorized) return guard.unauthorized;

  const sp = new URL(request.url).searchParams;
  const parsed = QuerySchema.safeParse({
    range: sp.get("range") ?? undefined,
    environment: sp.get("environment") ?? undefined,
    event: sp.get("event") ?? undefined,
    view: sp.get("view") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query parameters" }, { status: 400 });
  }
  const { range, environment, event, view } = parsed.data;

  // ── DRILL-DOWN: distinct persons behind Unique Visitors ──────────────────
  if (view === "persons") {
    const result = await getDistinctPersons(range, environment);
    if (result.status === "ok" && result.identified.length > 0) {
      const idByEmail = await emailToUserId(result.identified.map((p) => p.email));
      result.identified = resolvePersonUserIds(result.identified, idByEmail);
    }
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  }

  // ── DRILL-DOWN: the feed rows behind one overview count card ──────────────
  if (event) {
    const result = await getFilteredFeed(event, range, environment);
    if (result.status === "ok" && result.rows.length > 0) {
      const idByEmail = await emailToUserId(
        result.rows.map((r) => r.email).filter((e): e is string => typeof e === "string")
      );
      const nameById = await externalIdToName(collectCardExternalIds([result.rows], []));
      result.rows = attachFeedCardNames(resolveFeedUserIds(result.rows, idByEmail), nameById);
    }
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  }

  // ── Default: the full dashboard ──────────────────────────────────────────
  const result = await getPosthogAnalytics(range, environment);

  // DRILL-DOWN resolution for the default view: resolve each feed row's PostHog
  // person email → internal user id (feed User-cell link) AND every referenced
  // card externalId → card name (feed Detail cell + the most-added/-viewed/
  // -wishlisted lists). Both are ONE batched Prisma query; failure degrades
  // gracefully (unlinked / raw id), never 5xx. The email still comes only from
  // the person join (service).
  if (result.status === "ok") {
    const d = result.detail;
    if (d.recentActivity.length > 0) {
      const idByEmail = await emailToUserId(
        d.recentActivity.map((r) => r.email).filter((e): e is string => typeof e === "string")
      );
      d.recentActivity = resolveFeedUserIds(d.recentActivity, idByEmail);
    }
    // Resolve card names across the feed + every card list in one Prisma batch.
    const nameById = await externalIdToName(
      collectCardExternalIds(
        [d.recentActivity],
        [d.portfolio.mostAdded, d.search.mostViewedCards, d.wishlist.mostWishlisted]
      )
    );
    d.recentActivity = attachFeedCardNames(d.recentActivity, nameById);
    d.portfolio.mostAdded = attachCardAggNames(d.portfolio.mostAdded, nameById);
    d.search.mostViewedCards = attachCardAggNames(d.search.mostViewedCards, nameById);
    d.wishlist.mostWishlisted = attachCardAggNames(d.wishlist.mostWishlisted, nameById);
  }

  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
