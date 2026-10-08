/**
 * Admin Overview Dashboard — the Command Center landing.
 *
 * Server component. Pulls platform-wide financial + activity metrics
 * from the shared `admin-metrics` service so every stat is computed
 * the same way as the per-user views.
 */

import Link from "next/link";
import {
  getPlatformStats,
  getActiveUsers,
  getRecentPlatformActivity,
  getUserGrowthSeries,
  getCardsAddedSeries,
  getTopCollectedCards,
  type PlatformActivityItem,
} from "@/lib/services/admin-metrics";
import { formatRelative } from "@/lib/utils/format";
import {
  UserGrowthChart,
  CardsAddedChart,
  TopCollectedCardsChart,
} from "./_components/AnalyticsCharts";
import { LiveOverviewStats } from "./_components/LiveOverviewStats";

// Live, per-request authed read — the stat cards auto-refresh client-side, but
// the server render must stay dynamic so the SSR initialData is fresh too.
export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  const [stats, activeUsers, activity, userGrowth, cardsAdded, topCollected] =
    await Promise.all([
      getPlatformStats(),
      getActiveUsers(),
      getRecentPlatformActivity(10),
      getUserGrowthSeries(),
      getCardsAddedSeries(),
      getTopCollectedCards(10),
    ]);

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
          Overview
        </h1>
        <p className="dojo-body" style={{ marginTop: "6px" }}>
          Platform-wide financials and activity.{" "}
          <Link href="/admin/analytics" className="dojo-link">
            View detailed analytics →
          </Link>
        </p>
      </header>

      {/* ── Financial + Activity stat cards (live, auto-refresh ~25s) ── */}
      <LiveOverviewStats initialData={{ stats, activeUsers }} />

      {/* ── Analytics (real time-series) ── */}
      <SectionHeading>Analytics</SectionHeading>
      <section
        className="grid grid-cols-1 lg:grid-cols-2 gap-4"
        style={{ marginBottom: "16px" }}
      >
        <UserGrowthChart points={userGrowth.points} />
        <CardsAddedChart points={cardsAdded.points} />
      </section>
      <section style={{ marginBottom: "36px" }}>
        <TopCollectedCardsChart cards={topCollected} />
      </section>

      {/* ── Recent activity feed ── */}
      <SectionHeading>Recent Platform Activity</SectionHeading>
      <ActivityFeed items={activity} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="dojo-step-label"
      style={{
        fontSize: "10px",
        marginBottom: "12px",
        color: "var(--color-dojo-body)",
      }}
    >
      {children}
    </div>
  );
}

function ActivityFeed({ items }: { items: readonly PlatformActivityItem[] }) {
  if (items.length === 0) {
    return (
      <div
        style={{
          background: "var(--color-dojo-card)",
          border: "1px solid var(--color-dojo-stroke)",
          padding: "24px",
        }}
        className="dojo-faint"
      >
        No activity yet.
      </div>
    );
  }

  return (
    <ul
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        background: "var(--color-dojo-card)",
        border: "1px solid var(--color-dojo-stroke)",
      }}
    >
      {items.map((item, i) => (
        <li
          key={item.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "16px",
            padding: "14px 20px",
            borderTop:
              i === 0 ? "none" : "1px solid var(--color-dojo-divider)",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              background:
                item.kind === "user_joined"
                  ? "var(--color-dojo-jade)"
                  : "var(--color-dojo-gold)",
              flex: "none",
            }}
          />
          <span
            style={{
              color: "var(--color-dojo-ink)",
              fontSize: "13px",
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            <Link
              href={`/admin/users/${item.actorId}`}
              className="dojo-link"
              style={{
                fontSize: "13px",
                letterSpacing: 0,
                textTransform: "none",
              }}
            >
              {item.actorName}
            </Link>{" "}
            {renderActivityText(item)}
          </span>
          <span
            className="dojo-faint"
            style={{ fontSize: "11px", flex: "none" }}
          >
            {formatRelative(item.timestamp)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function renderActivityText(item: PlatformActivityItem): string {
  switch (item.kind) {
    case "user_joined":
      return "joined the platform";
    case "collection_added":
      return `added ${item.cardName ?? "a card"}${
        (item.quantity ?? 1) > 1 ? ` (×${item.quantity})` : ""
      } to their portfolio`;
  }
}
