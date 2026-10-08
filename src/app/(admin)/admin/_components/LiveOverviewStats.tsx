"use client";

/**
 * LiveOverviewStats — the auto-refreshing Overview stat cards.
 *
 * Wraps the Overview page's Financial + Activity stat cards in a single live
 * useQuery(['admin-overview']) against GET /api/admin/metrics/overview, hydrated
 * from the server page's `initialData` (first paint is populated — no empty
 * flash). Overrides the global TanStack defaults (staleTime 5m,
 * refetchOnWindowFocus:false) PER-QUERY so the cards refresh: staleTime 0 +
 * refetchInterval 25s + refetchOnWindowFocus. The summary charts stay in the
 * server page (they change slowly; a live refresh buys little).
 *
 * Admin panel = Tailwind utility classes allowed (AGENTS.md §10). Data computed
 * server-side; nothing fabricated (RULE 2). The DAU/WAU here is the same proxy
 * (Session.updatedAt) the analytics page uses.
 */

import { useQuery } from "@tanstack/react-query";
import { formatCurrency } from "@/lib/utils/format";
import type { PlatformStats, ActiveUsers } from "@/lib/services/admin-metrics";

export interface OverviewPayload {
  stats: PlatformStats;
  activeUsers: ActiveUsers;
}

export function LiveOverviewStats({
  initialData,
}: {
  initialData: OverviewPayload;
}) {
  const { data } = useQuery<OverviewPayload>({
    queryKey: ["admin-overview"],
    queryFn: async () => {
      const res = await fetch("/api/admin/metrics/overview", {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`overview ${res.status}`);
      return res.json();
    },
    initialData,
    staleTime: 0,
    refetchInterval: 25_000,
    refetchOnWindowFocus: true,
  });

  const { stats, activeUsers } = data;

  return (
    <>
      {/* ── Financial ── */}
      <SectionHeading>Financial</SectionHeading>
      <section
        className="grid grid-cols-1 md:grid-cols-2 gap-4"
        style={{ marginBottom: "28px" }}
      >
        <StatCard
          label="Total Platform Value"
          value={formatCurrency(stats.totalPlatformValue)}
          note="Current market value across every collection"
          highlight
        />
        <StatCard
          label="Total Invested"
          value={formatCurrency(stats.totalInvested)}
          note="Sum of recorded purchase prices"
          highlight
        />
      </section>

      {/* ── Activity ── */}
      <SectionHeading>Activity</SectionHeading>
      <section
        className="grid grid-cols-1 md:grid-cols-3 gap-4"
        style={{ marginBottom: "36px" }}
      >
        <StatCard
          label="Total Users"
          value={stats.totalUsers.toLocaleString()}
        />
        <StatCard
          label="Total Cards Tracked"
          value={stats.totalCardsTracked.toLocaleString()}
          note="Includes duplicates"
        />
        <StatCard
          label="Active Floor Listings"
          value={stats.activeFloorListings.toLocaleString()}
          note="Awaiting Floor schema"
        />
        <StatCard
          label="Daily Active Users"
          value={activeUsers.dau.toLocaleString()}
          note="Distinct sessions, last 24h"
        />
        <StatCard
          label="Weekly Active Users"
          value={activeUsers.wau.toLocaleString()}
          note="Distinct sessions, last 7 days"
        />
      </section>
    </>
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

function StatCard({
  label,
  value,
  note,
  highlight,
}: {
  label: string;
  value: string;
  note?: string;
  highlight?: boolean;
}) {
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
        {label}
      </div>
      <div
        className="dojo-count-up"
        style={{
          marginTop: "14px",
          fontFamily: "var(--font-serif)",
          fontSize: "38px",
          lineHeight: 1.1,
          color: highlight
            ? "var(--color-dojo-gold)"
            : "var(--color-dojo-ink)",
          wordBreak: "break-word",
        }}
      >
        {value}
      </div>
      {note ? (
        <div className="dojo-faint" style={{ marginTop: "10px" }}>
          {note}
        </div>
      ) : null}
    </article>
  );
}
