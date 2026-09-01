"use client";

/**
 * Screen 09 + 10 — Dashboard (Empty State & Populated)
 *
 * HYBRID APPROACH (MVP):
 * - UI matches the prototype exactly (chart, tabs, layout)
 * - Card lists use REAL data from the database
 * - Historical trends and daily % changes are MOCKED for MVP
 *
 * Tabs:
 * - Most Valuable: Real user's top 5 cards by marketPrice (mocked deltas)
 * - Collections: Real cards grouped by CardSet.name
 * - Gainers: Real cards with mocked positive deltas
 * - Losers: Real cards with mocked negative deltas
 *
 * Chart: 30-day mock data showing upward trend (visual only)
 */

import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/lib/auth-client";
import Link from "next/link";
import { useState, useMemo } from "react";
import { AreaChart, Area, ResponsiveContainer, YAxis } from "recharts";

// ── Types ──────────────────────────────────────────────────────────
interface CollectionItem {
  id: string;
  cardId: string;
  quantity: number;
  isFoil: boolean;
  purchasePrice: number | null;
  card: {
    id: string;
    name: string;
    marketPrice: number | null;
    set: { name: string } | null;
  };
}

type TabId = "mv" | "coll" | "gain" | "lose";

const TABS: { id: TabId; label: string }[] = [
  { id: "mv", label: "Most valuable" },
  { id: "coll", label: "Collections" },
  { id: "gain", label: "Gainers" },
  { id: "lose", label: "Losers" },
];

// ── Chart ranges ───────────────────────────────────────────────────
const RANGES = ["1D", "7D", "1M", "3M", "6M", "MAX"] as const;
type RangeId = (typeof RANGES)[number];

// Per-range mock chart shape.
//   startFraction  — how far below current value the series starts,
//                    so a bigger range implies more room for growth
//   volatility     — random-walk step size as a fraction of baseValue
//   trend          — deterministic drift per step (positive = upward),
//                    also as a fraction of baseValue
//   points         — number of samples on the x-axis
//
// Each range produces a visually distinct silhouette on the AreaChart:
//   1D  small intraday jitter, ~flat
//   7D  choppier week with a mild upward tilt
//   1M  clearer monthly climb (this is the shape from the reference)
//   3M  smoother quarterly trend, denser
//   6M  half-year climb with heavier volatility
//   MAX steepest growth curve, densest series
// TODO Week 3: Replace with real PricingHistory data from Postgres.
const RANGE_SHAPES: Record<
  RangeId,
  { startFraction: number; volatility: number; trend: number; points: number; seed: number }
> = {
  "1D": { startFraction: 0.98, volatility: 0.006, trend: 0.0004, points: 24, seed: 11 },
  "7D": { startFraction: 0.92, volatility: 0.015, trend: 0.002,  points: 28, seed: 23 },
  "1M": { startFraction: 0.78, volatility: 0.020, trend: 0.008,  points: 30, seed: 47 },
  "3M": { startFraction: 0.68, volatility: 0.017, trend: 0.005,  points: 45, seed: 71 },
  "6M": { startFraction: 0.55, volatility: 0.022, trend: 0.004,  points: 60, seed: 97 },
  "MAX": { startFraction: 0.30, volatility: 0.025, trend: 0.006, points: 80, seed: 131 },
};

// Small deterministic PRNG so switching ranges shows a stable shape
// per range (not a fresh random line on every render).
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateMockChartData(baseValue: number, range: RangeId): { value: number }[] {
  const { startFraction, volatility, trend, points, seed } = RANGE_SHAPES[range];
  const rand = mulberry32(seed);
  const start = baseValue * startFraction;
  const step = points > 1 ? (baseValue - start) / (points - 1) : 0;
  const data: { value: number }[] = [];
  let value = start;
  for (let i = 0; i < points; i++) {
    // Base drift so the series ends near `baseValue`
    const drift = step * i * (1 + trend * points);
    // Random walk around the drift line
    const noise = (rand() - 0.5) * baseValue * volatility * 2;
    value = Math.max(baseValue * 0.1, start + drift + noise);
    data.push({ value: Math.round(value * 100) / 100 });
  }
  // Pin the last point exactly on baseValue so the visible "market value"
  // number and the chart's right edge always agree.
  data[data.length - 1] = { value: baseValue };
  return data;
}

// Mock delta generator for MVP — returns a believable % change
// TODO Week 3: Replace mocked deltas with real PricingHistory calculations
function mockDelta(positive: boolean): { delta: string; pct: number } {
  const pct = positive
    ? 1 + Math.random() * 8 // +1% to +9%
    : -(0.5 + Math.random() * 4); // -0.5% to -4.5%
  return {
    delta: `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`,
    pct,
  };
}

// ── Icons ──────────────────────────────────────────────────────────
function SearchIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}
function BellIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 01-3.46 0" />
    </svg>
  );
}
function EyeIcon({ off }: { off?: boolean }) {
  return off ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function ChevronDown() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

const mask = "••••";

function fmt(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

// ── Delta tag component ────────────────────────────────────────────
function DeltaTag({ delta, up }: { delta: string; up: boolean }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9px",
        letterSpacing: "0.14em", textTransform: "uppercase",
        color: up ? "#00A86B" : "var(--color-dojo-vermilion)",
      }}
    >
      {up ? "▲" : "▼"} {delta}
    </span>
  );
}

// ── Card row component ─────────────────────────────────────────────
function SectionRow({ name, sub, price, delta, up }: { 
  name: string; sub: string; price: string; delta: string; up: boolean 
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", height: "57px", borderTop: "1px solid var(--color-dojo-divider)", cursor: "pointer" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13.5px", color: "var(--color-dojo-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {name}
        </div>
        <div style={{ marginTop: "3px", fontSize: "11px", color: "var(--color-dojo-body)" }}>
          {sub}
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "14px", fontVariantNumeric: "tabular-nums", color: "var(--color-dojo-ink)" }}>
          {price}
        </div>
        <div style={{ marginTop: "4px" }}>
          <DeltaTag delta={delta} up={up} />
        </div>
      </div>
    </div>
  );
}

// ── Collection row (for Collections tab) ───────────────────────────
function CollectionRow({ name, count, value, delta, up }: {
  name: string; count: number; value: number; delta: string; up: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", height: "57px", borderTop: "1px solid var(--color-dojo-divider)", cursor: "pointer" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13.5px", color: "var(--color-dojo-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {name}
        </div>
        <div style={{ marginTop: "3px", fontSize: "11px", color: "var(--color-dojo-body)" }}>
          {count} card{count !== 1 ? "s" : ""}
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "14px", fontVariantNumeric: "tabular-nums", color: "var(--color-dojo-ink)" }}>
          {fmt(value)}
        </div>
        <div style={{ marginTop: "4px" }}>
          <DeltaTag delta={delta} up={up} />
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { data: session } = useSession();
  const [activeTab, setActiveTab] = useState<TabId>("mv");
  const [activeRange, setActiveRange] = useState<RangeId>("1M");
  const [hidden, setHidden] = useState(false);

  const firstName = session?.user?.name?.split(" ")[0]?.toLowerCase() ?? "collector";
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const dateString = `${today} · Markets open`;

  // Fetch user's collection (real data)
  const { data: collectionData, isLoading } = useQuery<CollectionItem[]>({
    queryKey: ["collection"],
    queryFn: async () => {
      const res = await fetch("/api/users/me/collection");
      if (!res.ok) throw new Error("Failed to fetch collection");
      const json = await res.json();
      return json.items ?? [];
    },
  });

  const hasCollection = collectionData && collectionData.length > 0;

  // ── Computed stats from REAL data ────────────────────────────────
  const stats = useMemo(() => {
    const items = collectionData ?? [];
    const marketValue = items.reduce(
      (sum, i) => sum + (i.card.marketPrice ?? 0) * i.quantity, 0
    );
    const paid = items.reduce(
      (sum, i) => sum + (i.purchasePrice ?? 0) * i.quantity, 0
    );
    const unrealized = marketValue - paid;
    
    // Most valuable: top 5 by value (REAL cards, mocked deltas)
    const mostValuable = [...items]
      .sort((a, b) => (b.card.marketPrice ?? 0) * b.quantity - (a.card.marketPrice ?? 0) * a.quantity)
      .slice(0, 5)
      .map((item) => {
        const { delta, pct } = mockDelta(Math.random() > 0.3); // 70% positive
        return {
          name: item.card.name,
          sub: `${item.card.set?.name ?? "Unknown"} · Qty ${item.quantity}`,
          price: fmt((item.card.marketPrice ?? 0) * item.quantity),
          delta,
          up: pct >= 0,
        };
      });

    // Collections: group by CardSet.name (REAL data)
    const setGroups = new Map<string, { count: number; value: number }>();
    for (const item of items) {
      const setName = item.card.set?.name ?? "Unknown Set";
      const existing = setGroups.get(setName) ?? { count: 0, value: 0 };
      setGroups.set(setName, {
        count: existing.count + item.quantity,
        value: existing.value + (item.card.marketPrice ?? 0) * item.quantity,
      });
    }
    const collections = Array.from(setGroups.entries())
      .sort((a, b) => b[1].value - a[1].value)
      .slice(0, 5)
      .map(([name, data]) => {
        const { delta, pct } = mockDelta(Math.random() > 0.4);
        return { name, ...data, delta, up: pct >= 0 };
      });

    // Gainers: real cards with mocked POSITIVE deltas
    // TODO Week 3: Replace mocked deltas with real PricingHistory calculations
    const gainers = [...items]
      .sort((a, b) => (b.card.marketPrice ?? 0) - (a.card.marketPrice ?? 0))
      .slice(0, 5)
      .map((item) => {
        const { delta } = mockDelta(true); // Always positive
        return {
          name: item.card.name,
          sub: `${item.card.set?.name ?? "Unknown"} · Qty ${item.quantity}`,
          price: fmt((item.card.marketPrice ?? 0) * item.quantity),
          delta,
          up: true,
        };
      });

    // Losers: real cards with mocked NEGATIVE deltas
    // TODO Week 3: Replace mocked deltas with real PricingHistory calculations
    const losers = [...items]
      .sort((a, b) => (a.card.marketPrice ?? 0) - (b.card.marketPrice ?? 0))
      .slice(0, 5)
      .map((item) => {
        const { delta } = mockDelta(false); // Always negative
        return {
          name: item.card.name,
          sub: `${item.card.set?.name ?? "Unknown"} · Qty ${item.quantity}`,
          price: fmt((item.card.marketPrice ?? 0) * item.quantity),
          delta,
          up: false,
        };
      });

    // Client feedback: chart shape must differ per range. Recompute
    // when either the underlying value or the selected range changes.
    const chartData = generateMockChartData(marketValue, activeRange);

    // Mock overall delta (visual only for MVP)
    // Different ranges show different % gain magnitudes to match the
    // different chart shapes above (1D almost flat, MAX steepest).
    const OVERALL_PCT_BY_RANGE: Record<RangeId, number> = {
      "1D": 0.4,
      "7D": 2.1,
      "1M": 9.6,
      "3M": 14.3,
      "6M": 22.7,
      "MAX": 41.8,
    };
    const overallPct = OVERALL_PCT_BY_RANGE[activeRange];
    const overallDelta = marketValue * (overallPct / 100);

    return { marketValue, paid, unrealized, mostValuable, collections, gainers, losers, chartData, overallPct, overallDelta };
  }, [collectionData, activeRange]);

  // Get rows for the active tab
  const getActiveRows = () => {
    switch (activeTab) {
      case "mv": return stats.mostValuable;
      case "gain": return stats.gainers;
      case "lose": return stats.losers;
      default: return [];
    }
  };

  const getTabTitle = () => {
    switch (activeTab) {
      case "mv": return "Most valuable cards";
      case "coll": return "My collections";
      case "gain": return "Top gainers this week";
      case "lose": return "Top losers this week";
    }
  };

  return (
    <div style={{ padding: "6px 22px 24px" }}>
      {hasCollection ? (
        /* ══════════ POPULATED STATE ══════════ */
        <>
          {/* ── Header with collection selector ── */}
          <div style={{ display: "flex", alignItems: "center", marginTop: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "7px", border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)", padding: "6px 11px", cursor: "pointer" }}>
              <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-ink)", whiteSpace: "nowrap" }}>
                Main
              </span>
              <span style={{ display: "flex", color: "var(--color-dojo-body)" }}><ChevronDown /></span>
            </div>
            <div style={{ display: "flex", gap: "14px", alignItems: "center", color: "var(--color-dojo-body)", marginLeft: "auto" }}>
              <Link href="/search" style={{ display: "flex", color: "inherit" }}>
                <SearchIcon />
              </Link>
              <span style={{ position: "relative", display: "flex" }}>
                <BellIcon />
                <i style={{ position: "absolute", top: "-1px", right: "-2px", width: "6px", height: "6px", background: "var(--color-dojo-vermilion)", borderRadius: "50%" }} />
              </span>
            </div>
          </div>

          {/* ── Market value + eye toggle ── */}
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "16px" }}>
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontStretch: "112%", fontSize: "10px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
              Market value
            </span>
            <button
              onClick={() => setHidden((v) => !v)}
              title={hidden ? "Show values" : "Hide values"}
              style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "22px", height: "22px", cursor: "pointer", background: "none", border: "none", color: "var(--color-dojo-body)" }}
            >
              <EyeIcon off={hidden} />
            </button>
          </div>

          {/* ── Big value + delta ── */}
          <div style={{ marginTop: "6px", display: "flex", alignItems: "flex-end", gap: "16px" }}>
            <div style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "38px", lineHeight: 1.05, fontVariantNumeric: "tabular-nums", color: "var(--color-dojo-ink)" }}>
              {hidden ? `$ ${mask}${mask}` : fmt(stats.marketValue)}
            </div>
            <div style={{ flex: "none", paddingBottom: "6px", display: "flex", alignItems: "baseline", gap: "7px" }}>
              <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "#00A86B" }}>
                ▲ {hidden ? mask : `+${fmt(stats.overallDelta)}`}
              </span>
              <span style={{ color: "var(--color-dojo-faint)" }}>·</span>
              <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-ink)" }}>
                {activeRange}
              </span>
            </div>
          </div>

          {/* ── Paid / Realized / Unrealized ── */}
          <div style={{ display: "flex", gap: "12px", marginTop: "12px", paddingTop: "12px", borderTop: "1px solid var(--color-dojo-divider)", flexWrap: "nowrap", whiteSpace: "nowrap", overflowX: "auto" }}>
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
              Paid <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12.5px", letterSpacing: 0, color: "var(--color-dojo-ink)" }}>{hidden ? mask : fmt(stats.paid)}</span>
            </span>
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
              Realized <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12.5px", letterSpacing: 0, color: "#00A86B" }}>{hidden ? mask : `+${fmt(0)}`}</span>
            </span>
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
              Unrealized <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12.5px", letterSpacing: 0, color: stats.unrealized >= 0 ? "#00A86B" : "var(--color-dojo-vermilion)" }}>{hidden ? mask : `${stats.unrealized >= 0 ? "+" : ""}${fmt(stats.unrealized)}`}</span>
            </span>
          </div>

          {/* ── Chart (Recharts AreaChart with Dojo gold) ── */}
          <div style={{ margin: "16px -22px 0", height: "200px" }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.chartData} margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="dojoGold" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#E9B43B" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#E9B43B" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <YAxis domain={["dataMin", "dataMax"]} hide />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke="#E9B43B"
                  strokeWidth={2}
                  fill="url(#dojoGold)"
                  isAnimationActive={true}
                  animationDuration={700}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* ── Range selector tabs ── */}
          <div style={{ display: "flex" }}>
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setActiveRange(r)}
                style={{
                  flex: 1, textAlign: "center", padding: "9px 0 7px", cursor: "pointer",
                  background: "transparent", border: "none",
                  borderBottom: activeRange === r ? "2px solid var(--color-dojo-gold)" : "2px solid transparent",
                  fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9.5px", letterSpacing: "0.14em",
                  color: activeRange === r ? "var(--color-dojo-ink)" : "var(--color-dojo-faint)",
                }}
              >
                {r}
              </button>
            ))}
          </div>

          {/* ── Tab selector (Most valuable / Collections / Gainers / Losers) ── */}
          <div style={{ display: "flex", gap: "8px", overflowX: "auto", marginTop: "20px", paddingBottom: "2px" }}>
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  flex: "none", whiteSpace: "nowrap", padding: "9px 12px", cursor: "pointer",
                  border: "1px solid var(--color-dojo-stroke)",
                  fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase",
                  background: activeTab === tab.id ? "var(--color-dojo-gold)" : "transparent",
                  color: activeTab === tab.id ? "#0D0D0D" : "var(--color-dojo-body)",
                  boxShadow: "none",
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* ── Tab content ── */}
          <div style={{ marginTop: "12px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "2px 15px 6px" }}>
            <div style={{ display: "flex", alignItems: "center", padding: "14px 0" }}>
              <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
                {getTabTitle()}
              </span>
              <Link
                href="/portfolio"
                style={{ marginLeft: "auto", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-gold)", textDecoration: "none" }}
              >
                All ›
              </Link>
            </div>

            {activeTab === "coll" ? (
              /* Collections tab — grouped by CardSet */
              stats.collections.length > 0 ? (
                stats.collections.map((coll) => (
                  <CollectionRow key={coll.name} {...coll} />
                ))
              ) : (
                <div style={{ padding: "20px 0", textAlign: "center", color: "var(--color-dojo-faint)", fontSize: "12px" }}>
                  No collections yet
                </div>
              )
            ) : (
              /* Most valuable / Gainers / Losers tabs */
              getActiveRows().length > 0 ? (
                getActiveRows().map((row) => (
                  <SectionRow key={row.name} {...row} />
                ))
              ) : (
                <div style={{ padding: "20px 0", textAlign: "center", color: "var(--color-dojo-faint)", fontSize: "12px" }}>
                  No cards yet
                </div>
              )
            )}
          </div>
        </>
      ) : (
        /* ══════════ EMPTY STATE ══════════ */
        <>
          <div style={{ display: "flex", alignItems: "flex-start", gap: "14px", margin: "18px 0 18px" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p className="dojo-heading" style={{ fontSize: "24px", margin: 0 }}>
                welcome to the dojo, {firstName}.
              </p>
              <p style={{ marginTop: "8px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
                {dateString}
              </p>
            </div>
            <div style={{ display: "flex", gap: "16px", alignItems: "center", color: "var(--color-dojo-body)", paddingTop: "5px" }}>
              <Link href="/search" style={{ display: "flex", color: "inherit" }}>
                <SearchIcon />
              </Link>
              <BellIcon />
            </div>
          </div>

          <div style={{ background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "19px 20px" }}>
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontStretch: "112%", fontSize: "10px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
              Portfolio value
            </span>
            <div style={{ marginTop: "8px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "38px", lineHeight: 1.05, fontVariantNumeric: "tabular-nums", color: "var(--color-dojo-faint)" }}>
              {isLoading ? "—" : "$0.00"}
            </div>
            <div style={{ marginTop: "12px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
              Nothing tracked yet
            </div>
          </div>

          <div style={{ background: "var(--color-dojo-gold)", boxShadow: "6px 6px 0 0 #806A17", padding: "19px 20px", margin: "20px 6px 6px 0" }}>
            <p style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "15px", color: "#0D0D0D", margin: 0 }}>
              add your first card
            </p>
            <p style={{ marginTop: "6px", fontSize: "12px", lineHeight: 1.5, color: "rgba(13,13,13,0.75)", marginBottom: 0 }}>
              scan one you own, or search the catalog — takes under a minute.
            </p>
            <div style={{ display: "flex", gap: "14px", alignItems: "center", marginTop: "15px" }}>
              <Link
                href="/scanner"
                style={{
                  display: "inline-flex", alignItems: "center", gap: "6px",
                  background: "#0D0D0D", color: "#fff",
                  fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "10.5px", letterSpacing: "0.14em",
                  padding: "12px 16px", textDecoration: "none", border: "none",
                }}
              >
                SCAN A CARD
              </Link>
              <Link
                href="/search"
                style={{
                  fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase",
                  color: "#0D0D0D", textDecoration: "none",
                }}
              >
                Search ›
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
