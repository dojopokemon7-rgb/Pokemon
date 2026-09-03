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
  getRecentPlatformActivity,
  type PlatformActivityItem,
} from "@/lib/services/admin-metrics";
import { formatCurrency, formatRelative } from "@/lib/utils/format";

interface Stat {
  label: string;
  value: string;
  note?: string;
  highlight?: boolean;
}

export default async function AdminOverviewPage() {
  const [stats, activity] = await Promise.all([
    getPlatformStats(),
    getRecentPlatformActivity(10),
  ]);

  const financial: readonly Stat[] = [
    {
      label: "Total Platform Value",
      value: formatCurrency(stats.totalPlatformValue),
      note: "Current market value across every collection",
      highlight: true,
    },
    {
      label: "Total Invested",
      value: formatCurrency(stats.totalInvested),
      note: "Sum of recorded purchase prices",
      highlight: true,
    },
  ];

  const activityStats: readonly Stat[] = [
    { label: "Total Users", value: stats.totalUsers.toLocaleString() },
    {
      label: "Total Cards Tracked",
      value: stats.totalCardsTracked.toLocaleString(),
      note: "Includes duplicates",
    },
    {
      label: "Active Floor Listings",
      value: stats.activeFloorListings.toLocaleString(),
      note: "Awaiting Floor schema",
    },
  ];

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
          Platform-wide financials and activity.
        </p>
      </header>

      {/* ── Financial ── */}
      <SectionHeading>Financial</SectionHeading>
      <section
        className="grid grid-cols-1 md:grid-cols-2 gap-4"
        style={{ marginBottom: "28px" }}
      >
        {financial.map((s) => (
          <StatCard key={s.label} stat={s} />
        ))}
      </section>

      {/* ── Activity ── */}
      <SectionHeading>Activity</SectionHeading>
      <section
        className="grid grid-cols-1 md:grid-cols-3 gap-4"
        style={{ marginBottom: "36px" }}
      >
        {activityStats.map((s) => (
          <StatCard key={s.label} stat={s} />
        ))}
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

function StatCard({ stat }: { stat: Stat }) {
  return (
    <article
      style={{
        background: "var(--color-dojo-card)",
        border: "1px solid var(--color-dojo-stroke)",
        padding: "24px 24px 28px",
      }}
    >
      <div
        className="dojo-step-label"
        style={{ fontSize: "10px", color: "var(--color-dojo-body)" }}
      >
        {stat.label}
      </div>
      <div
        className="dojo-count-up"
        style={{
          marginTop: "14px",
          fontFamily: "var(--font-serif)",
          fontSize: "38px",
          lineHeight: 1.1,
          color: stat.highlight
            ? "var(--color-dojo-gold)"
            : "var(--color-dojo-ink)",
          wordBreak: "break-word",
        }}
      >
        {stat.value}
      </div>
      {stat.note ? (
        <div className="dojo-faint" style={{ marginTop: "10px" }}>
          {stat.note}
        </div>
      ) : null}
    </article>
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
