"use client";

/**
 * AnalyticsDetail — the live /admin/analytics detail panel.
 *
 * Renders the five FEAT-001 metric groups (scan usage + estimated Vision
 * credits, portfolio totals, per-game split, top collected/wanted/scanned,
 * DAU/WAU) from the FEAT-002 route GET /api/admin/metrics/analytics.
 *
 * LIVE: a single useQuery(['admin-analytics']) hydrated from the server page's
 * `initialData` (so first paint is populated — no empty flash), overriding the
 * global TanStack defaults (staleTime 5m, refetchOnWindowFocus:false) PER-QUERY
 * so the panel actually auto-refreshes: refetchInterval 25s + refetchOnWindowFocus.
 *
 * Admin panel = Tailwind utility classes allowed (AGENTS.md §10). All DATA is
 * computed server-side; nothing is fabricated here (RULE 2). Empty groups render
 * an honest "No data yet." — a true-zero range is NOT a flat fake line.
 */

import { useQuery } from "@tanstack/react-query";
import { AreaChart, type AreaChartDatum } from "@/components/AreaChart";
import { formatCurrency } from "@/lib/utils/format";
import type {
  ScanUsageSeries,
  PortfolioTotals,
  PerGameSplit,
  ActiveUsers,
  TopCollectedCard,
  RankedCard,
} from "@/lib/services/admin-metrics";

export interface AnalyticsPayload {
  scanUsage: ScanUsageSeries;
  portfolioTotals: PortfolioTotals;
  perGameSplit: PerGameSplit;
  activeUsers: ActiveUsers;
  topCollected: TopCollectedCard[];
  topWanted: RankedCard[];
  mostScanned: RankedCard[];
}

const CARD_STYLE: React.CSSProperties = {
  background: "var(--color-dojo-card)",
  border: "1px solid var(--color-dojo-stroke)",
  padding: "24px",
};

/** Short "Jul 4" style UTC label for the x-axis. */
function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function AnalyticsDetail({
  initialData,
}: {
  initialData: AnalyticsPayload;
}) {
  // Live admin query: override the global staleTime/refetchOnWindowFocus so the
  // panel auto-refreshes. SSR initialData means the first paint is already real.
  const { data } = useQuery<AnalyticsPayload>({
    queryKey: ["admin-analytics"],
    queryFn: async () => {
      const res = await fetch("/api/admin/metrics/analytics", {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`analytics ${res.status}`);
      return res.json();
    },
    initialData,
    staleTime: 0,
    refetchInterval: 25_000,
    refetchOnWindowFocus: true,
  });

  const {
    scanUsage,
    portfolioTotals,
    perGameSplit,
    activeUsers,
    topCollected,
    topWanted,
    mostScanned,
  } = data;

  return (
    <div className="grid grid-cols-1 gap-8">
      {/* ── Active Users ── */}
      <section>
        <SectionHeading>Active Users</SectionHeading>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <StatCard
            label="Daily Active (DAU)"
            value={activeUsers.dau.toLocaleString()}
            note="Distinct sessions used in the last 24h"
          />
          <StatCard
            label="Weekly Active (WAU)"
            value={activeUsers.wau.toLocaleString()}
            note="Distinct sessions used in the last 7 days"
          />
        </div>
      </section>

      {/* ── Portfolio Totals ── */}
      <section>
        <SectionHeading>Portfolio Totals</SectionHeading>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Total Portfolio Value"
            value={formatCurrency(portfolioTotals.totalPortfolioValue)}
            note="Active holdings only (raw price for graded)"
            highlight
          />
          <StatCard
            label="Active Cards"
            value={portfolioTotals.activeCards.toLocaleString()}
            note="Owned quantity, excludes sold"
          />
          <StatCard
            label="Total Users"
            value={portfolioTotals.totalUsers.toLocaleString()}
          />
          <StatCard
            label="Avg Collection Size"
            value={portfolioTotals.averageCollectionSize.toLocaleString(
              undefined,
              { maximumFractionDigits: 1 }
            )}
            note="Active cards per user"
          />
        </div>
      </section>

      {/* ── Scan Usage ── */}
      <section>
        <SectionHeading>Scan Usage</SectionHeading>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Total Scans"
            value={scanUsage.totalScans.toLocaleString()}
            note="Last 90 days"
          />
          <StatCard
            label="Successful"
            value={scanUsage.successfulScans.toLocaleString()}
            note="A card was confirmed"
          />
          <StatCard
            label="Failed"
            value={scanUsage.failedScans.toLocaleString()}
            note="No card picked"
          />
          <StatCard
            label="Vision Credits"
            value={scanUsage.estimatedVisionCredits.toLocaleString()}
            note="Estimated — not metered by SyncLog"
          />
        </div>
        <div style={{ ...CARD_STYLE, marginTop: "16px" }}>
          <div
            className="dojo-step-label"
            style={{ fontSize: "10px", color: "var(--color-dojo-body)" }}
          >
            Scans Per Day
          </div>
          <div className="dojo-faint" style={{ marginTop: "6px" }}>
            Successful vs failed scans per day (last 90 days, UTC)
          </div>
          <div style={{ marginTop: "16px" }}>
            <ScanUsageChart points={scanUsage.points} />
          </div>
        </div>
      </section>

      {/* ── Per-Game Split ── */}
      <section>
        <SectionHeading>Per-Game Split</SectionHeading>
        <PerGameSplitCard split={perGameSplit} />
      </section>

      {/* ── Ranked lists ── */}
      <section>
        <SectionHeading>Top Cards</SectionHeading>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <RankedList
            title="Top Collected"
            note="Most-added across all users"
            items={topCollected.map((c) => ({
              key: c.cardId,
              name: c.name,
              count: c.totalQuantity,
            }))}
          />
          <RankedList
            title="Top Wanted"
            note="Most-wanted across all want lists"
            items={topWanted.map((c) => ({
              key: c.cardId,
              name: c.name ?? c.cardId,
              count: c.count,
            }))}
          />
          <RankedList
            title="Most Scanned"
            note="Most-picked after a scan"
            items={mostScanned.map((c) => ({
              key: c.cardId,
              name: c.name ?? c.cardId,
              count: c.count,
            }))}
          />
        </div>
      </section>
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
    <article style={CARD_STYLE}>
      <div
        className="dojo-step-label"
        style={{ fontSize: "10px", color: "var(--color-dojo-body)" }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: "14px",
          fontFamily: "var(--font-serif)",
          fontSize: "30px",
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

/**
 * Scan usage chart — the two-series success/fail view. ScanDailyCount
 * (success/fail) is NOT a single DailyCount, so we feed AreaChart two series
 * (per FEAT-001 note). COUNT axis → showYAxis=false (a "$…K" label would
 * misrepresent counts). Honest empty when every day is 0/0.
 */
function ScanUsageChart({
  points,
}: {
  points: ScanUsageSeries["points"];
}) {
  const hasData = points.some((p) => p.success > 0 || p.fail > 0);
  if (!hasData) {
    return (
      <div className="dojo-faint" style={{ padding: "32px 0" }}>
        No data yet.
      </div>
    );
  }
  const data: AreaChartDatum[] = points.map((p) => ({
    label: dayLabel(p.date),
    success: p.success,
    fail: p.fail,
  }));
  return (
    <AreaChart
      data={data}
      series={[
        { valueKey: "success", label: "Successful" },
        { valueKey: "fail", label: "Failed" },
      ]}
      height={220}
      showYAxis={false}
      valueFormat="count"
      ariaLabel="Successful versus failed scans per day"
    />
  );
}

/**
 * Per-game split — a two-slice horizontal bar breakdown of owned quantity.
 * Honest "No data yet." when neither game has active holdings.
 */
function PerGameSplitCard({ split }: { split: PerGameSplit }) {
  const total = split.pokemon + split.onePiece;
  if (total === 0) {
    return (
      <article style={CARD_STYLE}>
        <div className="dojo-faint" style={{ padding: "32px 0" }}>
          No data yet.
        </div>
      </article>
    );
  }
  const rows = [
    { label: "Pokémon", value: split.pokemon, color: "var(--color-dojo-gold)" },
    {
      label: "One Piece",
      value: split.onePiece,
      color: "var(--color-dojo-jade)",
    },
  ];
  return (
    <article style={CARD_STYLE}>
      <div className="dojo-faint" style={{ marginBottom: "16px" }}>
        Owned-card quantity by game (active holdings only)
      </div>
      <ul className="grid gap-4" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {rows.map((r) => {
          const pct = total > 0 ? (r.value / total) * 100 : 0;
          return (
            <li key={r.label}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "12px",
                  fontSize: "13px",
                  color: "var(--color-dojo-ink)",
                  marginBottom: "6px",
                }}
              >
                <span>{r.label}</span>
                <span className="dojo-faint">
                  {r.value.toLocaleString()} ({pct.toFixed(0)}%)
                </span>
              </div>
              <div style={{ height: "8px", background: "var(--color-dojo-divider)" }}>
                <div
                  style={{ height: "100%", width: `${pct}%`, background: r.color }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </article>
  );
}

/** A ranked card list rendered as the TopCollected bar style. */
function RankedList({
  title,
  note,
  items,
}: {
  title: string;
  note?: string;
  items: { key: string; name: string; count: number }[];
}) {
  const max = items.length > 0 ? items[0].count : 0;
  return (
    <article style={CARD_STYLE}>
      <div
        className="dojo-step-label"
        style={{ fontSize: "10px", color: "var(--color-dojo-body)" }}
      >
        {title}
      </div>
      {note ? (
        <div className="dojo-faint" style={{ marginTop: "6px" }}>
          {note}
        </div>
      ) : null}
      <div style={{ marginTop: "16px" }}>
        {items.length === 0 ? (
          <div className="dojo-faint" style={{ padding: "32px 0" }}>
            No data yet.
          </div>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "10px" }}>
            {items.map((c) => (
              <li key={c.key}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "12px",
                    fontSize: "13px",
                    color: "var(--color-dojo-ink)",
                    marginBottom: "4px",
                  }}
                >
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                    }}
                  >
                    {c.name}
                  </span>
                  <span className="dojo-faint" style={{ flex: "none" }}>
                    {c.count.toLocaleString()}
                  </span>
                </div>
                <div style={{ height: "6px", background: "var(--color-dojo-divider)" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${max > 0 ? (c.count / max) * 100 : 0}%`,
                      background: "var(--color-dojo-gold)",
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}
