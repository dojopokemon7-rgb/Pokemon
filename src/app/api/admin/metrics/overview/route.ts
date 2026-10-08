/**
 * GET /api/admin/metrics/overview
 *
 * Admin-only. Returns the live platform Overview stat payload the admin
 * dashboard cards render: the headline platform stats (users, value, invested,
 * cards tracked) plus day/week active-user counts.
 *
 * SECURITY: guarded by the EXISTING requireAdmin (401 unauth / 403 non-admin,
 * fresh-DB isAdmin re-read). Platform-wide financials/user data must NEVER leak
 * to a non-admin. Route stays thin — all computation lives in admin-metrics.ts.
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/utils/auth-guard";
import { getPlatformStats, getActiveUsers } from "@/lib/services/admin-metrics";

// Live, per-request authed read — never statically cached.
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const guard = await requireAdmin(request);
  if (guard.unauthorized) return guard.unauthorized;

  const [stats, activeUsers] = await Promise.all([
    getPlatformStats(),
    getActiveUsers(),
  ]);

  return NextResponse.json(
    { stats, activeUsers },
    { headers: { "Cache-Control": "no-store" } }
  );
}
