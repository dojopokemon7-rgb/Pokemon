/**
 * GET /api/admin/metrics/analytics
 *
 * Admin-only. Returns the richer detail aggregates for the admin analytics
 * panel in one JSON object: scan-usage series (+ estimated Vision credits),
 * portfolio totals, per-game owned split, active users, and the top
 * collected / wanted / most-scanned cards.
 *
 * SECURITY: guarded by the EXISTING requireAdmin (401 unauth / 403 non-admin,
 * fresh-DB isAdmin re-read). None of these platform-wide aggregates may leak to
 * a non-admin. Route stays thin — all computation lives in admin-metrics.ts.
 *
 * CACHING: intentionally NOT Redis-cached. These are per-request authed reads
 * for the low-traffic admin panel; the grouped aggregates run once per page
 * load, so a short-TTL cache would add fail-open complexity (RULE 1) for no
 * meaningful win. Add a read-through here if the panel ever polls aggressively.
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/utils/auth-guard";
import {
  getScanUsageSeries,
  getPortfolioTotals,
  getPerGameSplit,
  getActiveUsers,
  getTopCollectedCards,
  getTopWantedCards,
  getMostScannedCards,
} from "@/lib/services/admin-metrics";

// Live, per-request authed read — never statically cached.
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const guard = await requireAdmin(request);
  if (guard.unauthorized) return guard.unauthorized;

  const [
    scanUsage,
    portfolioTotals,
    perGameSplit,
    activeUsers,
    topCollected,
    topWanted,
    mostScanned,
  ] = await Promise.all([
    getScanUsageSeries(),
    getPortfolioTotals(),
    getPerGameSplit(),
    getActiveUsers(),
    getTopCollectedCards(),
    getTopWantedCards(),
    getMostScannedCards(),
  ]);

  return NextResponse.json(
    {
      scanUsage,
      portfolioTotals,
      perGameSplit,
      activeUsers,
      topCollected,
      topWanted,
      mostScanned,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
