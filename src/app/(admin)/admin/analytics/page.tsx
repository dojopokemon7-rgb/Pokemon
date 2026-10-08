/**
 * Admin Analytics — the detail dashboard.
 *
 * Server component. Computes the five FEAT-001 detail aggregate groups
 * server-side (the SAME service calls as GET /api/admin/metrics/analytics) and
 * hands them to the live <AnalyticsDetail/> client panel as `initialData`, so
 * the first paint is already populated (no empty flash). The client panel then
 * auto-refreshes every ~25s and on window focus.
 *
 * Mirrors the Overview page header/section styling. Admin status is enforced by
 * the (admin) layout (fresh-DB isAdmin re-read) — this page is already behind it.
 */

import {
  getScanUsageSeries,
  getPortfolioTotals,
  getPerGameSplit,
  getActiveUsers,
  getTopCollectedCards,
  getTopWantedCards,
  getMostScannedCards,
} from "@/lib/services/admin-metrics";
import {
  AnalyticsDetail,
  type AnalyticsPayload,
} from "../_components/AnalyticsDetail";

// Live, per-request authed read — never statically cached (fresh SSR initialData).
export const dynamic = "force-dynamic";

export default async function AdminAnalyticsPage() {
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

  const initialData: AnalyticsPayload = {
    scanUsage,
    portfolioTotals,
    perGameSplit,
    activeUsers,
    topCollected,
    topWanted,
    mostScanned,
  };

  return (
    <div className="px-10 py-10">
      <header className="mb-8">
        <div
          className="dojo-step-label"
          style={{ fontSize: "10px", marginBottom: "8px" }}
        >
          Admin
        </div>
        <h1 className="dojo-heading" style={{ fontSize: "32px" }}>
          Analytics
        </h1>
        <p className="dojo-body" style={{ marginTop: "6px" }}>
          Scan usage, portfolio totals, per-game split, and top cards. Auto-refreshes.
        </p>
      </header>

      <AnalyticsDetail initialData={initialData} />
    </div>
  );
}
