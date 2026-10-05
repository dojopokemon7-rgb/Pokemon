"use client";

/**
 * AnalyticsCharts — client wrappers that render the admin overview's
 * time-series analytics inside StatCard-matching cards.
 *
 * The shared design-system <AreaChart> (src/components/AreaChart.tsx) is a
 * client component (hover state), so it can't be used directly from the
 * server page — these thin wrappers bridge that boundary. All DATA is computed
 * server-side in admin-metrics.ts and passed in as props; nothing is fetched or
 * fabricated here (AGENTS.md rule 2).
 *
 * A series with no real signal (empty points, or every point still 0) renders
 * an honest "No data yet" state instead of a flat fake line.
 */

import { AreaChart, type AreaChartDatum } from "@/components/AreaChart";
import type { DailyCount } from "@/lib/utils/admin-analytics";
import type { TopCollectedCard } from "@/lib/services/admin-metrics";

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

function ChartCard({
  title,
  note,
  hasData,
  children,
}: {
  title: string;
  note?: string;
  hasData: boolean;
  children: React.ReactNode;
}) {
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
        {hasData ? (
          children
        ) : (
          <div className="dojo-faint" style={{ padding: "32px 0" }}>
            No data yet.
          </div>
        )}
      </div>
    </article>
  );
}

export function UserGrowthChart({ points }: { points: DailyCount[] }) {
  // Cumulative series: "has data" means at least one user exists (the last
  // running total is > 0). An all-zero curve = empty platform → honest empty.
  const hasData = points.length > 0 && points[points.length - 1].count > 0;
  const data: AreaChartDatum[] = points.map((p) => ({
    label: dayLabel(p.date),
    value: p.count,
  }));
  return (
    <ChartCard
      title="User Growth"
      note="Cumulative total users (last 90 days, UTC)"
      hasData={hasData}
    >
      <AreaChart data={data} valueKey="value" height={200} trendColor={false} />
    </ChartCard>
  );
}

export function CardsAddedChart({ points }: { points: DailyCount[] }) {
  // Per-day adds: "has data" means at least one day had a real add.
  const hasData = points.some((p) => p.count > 0);
  const data: AreaChartDatum[] = points.map((p) => ({
    label: dayLabel(p.date),
    value: p.count,
  }));
  return (
    <ChartCard
      title="Cards Added"
      note="Collection adds per day (last 90 days, UTC)"
      hasData={hasData}
    >
      <AreaChart data={data} valueKey="value" height={200} trendColor={false} />
    </ChartCard>
  );
}

export function TopCollectedCardsChart({
  cards,
}: {
  cards: TopCollectedCard[];
}) {
  const max = cards.length > 0 ? cards[0].totalQuantity : 0;
  return (
    <ChartCard
      title="Top Collected Cards"
      note="Most-added cards across all users"
      hasData={cards.length > 0}
    >
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "10px" }}>
        {cards.map((c) => (
          <li key={c.cardId}>
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
                {c.totalQuantity.toLocaleString()}
              </span>
            </div>
            {/* Horizontal bar scaled to the top card's quantity. */}
            <div style={{ height: "6px", background: "var(--color-dojo-divider)" }}>
              <div
                style={{
                  height: "100%",
                  width: `${max > 0 ? (c.totalQuantity / max) * 100 : 0}%`,
                  background: "var(--color-dojo-gold)",
                }}
              />
            </div>
          </li>
        ))}
      </ul>
    </ChartCard>
  );
}
