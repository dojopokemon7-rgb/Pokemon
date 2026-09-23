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
import Link from "next/link";
import { useState, useMemo, useRef } from "react";
import { CardDetailsPopup, type CardDetailsData } from "@/components/CardDetailsPopup";
import { HeaderLeftSlot } from "../../header-slot";

// ── Types ──────────────────────────────────────────────────────────
export interface CollectionItem {
  id: string;
  cardId: string;
  quantity: number;
  isFoil: boolean;
  purchasePrice: number | null;
  /** Free-text grade/condition (e.g. "PSA 10") — drives graded counts. */
  condition?: string | null;
  /** F-11: named collection this copy is filed under (null = uncategorized). */
  collectionId?: string | null;
  card: {
    id: string;
    name: string;
    marketPrice: number | null;
    set: { name: string } | null;
  };
}

// F-08: map a collection row to the shape the details popup needs. The
// dashboard's CollectionItem carries the DB card id (used as the detail
// path segment, matching the portfolio page) — that's sufficient to open
// the popup and toggle favorites from Home.
function toPopupCard(item: CollectionItem): CardDetailsData {
  return {
    externalId: item.cardId,
    name: item.card.name,
    setName: item.card.set?.name ?? undefined,
    marketPrice: item.card.marketPrice,
  };
}

type TabId = "mv" | "coll" | "gain" | "lose" | "buy" | "sell" | "trade";

const TABS: { id: TabId; label: string }[] = [
  { id: "mv", label: "Most Valuable" },
  { id: "coll", label: "Collections" },
  { id: "gain", label: "Gainers" },
  { id: "lose", label: "Losers" },
  { id: "buy", label: "Want to Buy" },
  { id: "sell", label: "Want to Sell" },
  { id: "trade", label: "Want to Trade" },
];

// Want-list item shape from GET /api/want-list (service resolves name /
// price / set from the catalog by externalId).
interface WantListApiItem {
  id: string;
  cardId: string;
  intent: "BUY" | "SELL" | "TRADE";
  name: string | null;
  imageUrl: string | null;
  marketPrice: number | null;
  setName: string | null;
}

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
const mask = "••••";

function fmt(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

// ── Inline SVG area chart ──────────────────────────────────────────
// Zero-dep replacement for recharts' <AreaChart>. Renders one
// `preserveAspectRatio="none"` viewBox so the polyline stretches to
// the container size — same fluid resize behaviour recharts gave us,
// without shipping d3-scale / d3-shape / d3-array / d3-color to the
// browser.
//
// Interaction (Phase 2 QA: chart tooltips/hover must work on mobile):
// a pointer/touch anywhere over the chart snaps to the nearest data
// point and shows a vertical guide, a marker dot, and a value tooltip.
// Because the viewBox is stretched (preserveAspectRatio="none"), we map
// the pointer to a data index from the container's real pixel width via
// the pointer event's offset fraction — no d3, no scale math needed.
function MiniAreaChart({
  data,
  formatValue,
}: {
  data: readonly { value: number }[];
  formatValue?: (v: number) => string;
}) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  if (data.length < 2) return <div style={{ height: "100%" }} />;

  const W = 400;
  const H = 200;
  const values = data.map((d) => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const step = W / (data.length - 1);
  const y = (v: number) => H - ((v - min) / range) * (H - 8) - 4;

  const linePoints = data
    .map((d, i) => `${i * step},${y(d.value)}`)
    .join(" ");
  const areaPath =
    `M0,${H} L` +
    data.map((d, i) => `${i * step},${y(d.value)}`).join(" L") +
    ` L${W},${H} Z`;

  // Map a client X coordinate to the nearest data index using the real
  // rendered width (viewBox X is meaningless here — it's stretched).
  const idxFromClientX = (clientX: number): number => {
    const el = wrapRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(frac * (data.length - 1));
  };

  const handleMove = (clientX: number) => setActiveIdx(idxFromClientX(clientX));
  const clear = () => setActiveIdx(null);

  const active = activeIdx != null ? data[activeIdx] : null;
  const activeXFrac = activeIdx != null ? activeIdx / (data.length - 1) : 0;
  const fmtV = formatValue ?? ((v: number) => String(Math.round(v)));

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", width: "100%", height: "100%", touchAction: "none" }}
      onMouseMove={(e) => handleMove(e.clientX)}
      onMouseLeave={clear}
      onTouchStart={(e) => e.touches[0] && handleMove(e.touches[0].clientX)}
      onTouchMove={(e) => e.touches[0] && handleMove(e.touches[0].clientX)}
      onTouchEnd={clear}
      role="img"
      aria-label="Portfolio value trend chart"
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        width="100%"
        height="100%"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="dojoGold" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-dojo-gold)" stopOpacity={0.3} />
            <stop offset="100%" stopColor="var(--color-dojo-gold)" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#dojoGold)" />
        <polyline
          points={linePoints}
          fill="none"
          stroke="var(--color-dojo-gold)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
        {/* Vertical guide line at the active point. drawn in viewBox
            space; x uses the same `step` mapping as the polyline. */}
        {activeIdx != null && (
          <line
            x1={activeIdx * step}
            y1={0}
            x2={activeIdx * step}
            y2={H}
            stroke="rgba(255,255,255,0.25)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      {/* Marker dot — positioned with CSS percentages against the real
          container box so it lands correctly despite the stretched
          viewBox. */}
      {active != null && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: `${activeXFrac * 100}%`,
            top: `${(y(active.value) / H) * 100}%`,
            width: 9,
            height: 9,
            marginLeft: -4.5,
            marginTop: -4.5,
            borderRadius: "50%",
            background: "var(--color-dojo-gold)",
            boxShadow: "0 0 0 3px rgba(233,180,59,0.25)",
            pointerEvents: "none",
          }}
        />
      )}

      {/* Value tooltip — follows the active x, clamped from the edges so
          it never overflows the chart. */}
      {active != null && (
        <div
          style={{
            position: "absolute",
            left: `${Math.min(88, Math.max(12, activeXFrac * 100))}%`,
            top: 4,
            transform: "translateX(-50%)",
            background: "var(--color-dojo-overlay)",
            border: "1px solid var(--color-dojo-stroke)",
            padding: "4px 8px",
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: "11px",
            fontVariantNumeric: "tabular-nums",
            color: "var(--color-dojo-ink)",
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          {fmtV(active.value)}
        </div>
      )}
    </div>
  );
}

// ── Delta tag component ────────────────────────────────────────────
function DeltaTag({ delta, up }: { delta: string; up: boolean }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9px",
        letterSpacing: "0.14em", textTransform: "uppercase",
        color: up ? "var(--color-dojo-jade)" : "var(--color-dojo-vermilion)",
      }}
    >
      {up ? "▲" : "▼"} {delta}
    </span>
  );
}

// ── Card row component ─────────────────────────────────────────────
// F-08: rows are clickable and carry the `card-result` testid so a click
// opens the shared details popup (same behaviour as the Explore tiles).
function SectionRow({ name, sub, price, delta, up, onOpen }: {
  name: string; sub: string; price: string; delta: string; up: boolean;
  onOpen?: () => void;
}) {
  return (
    <div
      data-testid="card-result"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (onOpen && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen();
        }
      }}
      style={{ display: "flex", alignItems: "center", height: "57px", borderTop: "1px solid var(--color-dojo-divider)", cursor: "pointer" }}
    >
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
// Sub line matches the design's "120 cards · 4 graded" format; the graded
// count is omitted when zero so ungraded collections read cleanly.
function CollectionRow({ name, count, graded, value, delta, up }: {
  name: string; count: number; graded: number; value: number; delta: string; up: boolean;
}) {
  const sub = graded > 0
    ? `${count} card${count !== 1 ? "s" : ""} · ${graded} graded`
    : `${count} card${count !== 1 ? "s" : ""}`;
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
          {fmt(value)}
        </div>
        <div style={{ marginTop: "4px" }}>
          <DeltaTag delta={delta} up={up} />
        </div>
      </div>
    </div>
  );
}

interface DashboardClientProps {
  /** First name of the logged-in user, resolved server-side. */
  firstName: string;
  /** User's collection, pre-fetched on the server so the first paint
   *  has real data (no loading flash, no client round-trip). Client-
   *  side mutations still invalidate the ["collection"] query key so
   *  the UI stays in sync after add / delete flows. */
  initialItems: CollectionItem[];
  /** F-11: the user's named collections for the dashboard selector. */
  collections?: { id: string; name: string }[];
}

export default function DashboardClient({
  firstName,
  initialItems,
  collections: collectionList = [],
}: DashboardClientProps) {
  const [activeTab, setActiveTab] = useState<TabId>("mv");
  const [activeRange, setActiveRange] = useState<RangeId>("1M");
  const [hidden, setHidden] = useState(false);
  // Multi-select collection filter (F-11). A set of collection ids that are
  // currently included; an EMPTY set means "all collections" (no filter).
  // The "__uncat__" sentinel selects uncategorized (loose) cards.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Whether the selector dropdown panel is open.
  const [collMenuOpen, setCollMenuOpen] = useState(false);
  // F-08: the card whose details popup is open (null = closed).
  const [popupCard, setPopupCard] = useState<CardDetailsData | null>(null);

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const dateString = `${today} · Markets open`;

  // Server-rendered initial data + React Query for reactivity. Because
  // `initialData` is populated, `isLoading` is false on first render —
  // the paint uses real numbers, not a spinner. Subsequent invalidations
  // (add-to-collection flow) trigger a normal client refetch.
  const { data: collectionData, isLoading } = useQuery<CollectionItem[]>({
    queryKey: ["collection"],
    queryFn: async () => {
      const res = await fetch("/api/users/me/collection");
      if (!res.ok) throw new Error("Failed to fetch collection");
      const json = await res.json();
      return json.items ?? [];
    },
    initialData: initialItems,
  });

  const hasCollection = collectionData && collectionData.length > 0;

  // Want List (F-07) for the Want to Buy / Sell / Trade tabs. One fetch of
  // all intents (the service resolves name / price / set per item); the UI
  // filters by intent below. Shares the ["want-list"] key family the
  // wantlist page uses, so adds/moves there keep this in sync.
  const { data: wantItems = [] } = useQuery<WantListApiItem[]>({
    queryKey: ["want-list", "all"],
    queryFn: async () => {
      const res = await fetch("/api/want-list", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch want list");
      const json = await res.json();
      return (json.data ?? []) as WantListApiItem[];
    },
  });

  // Map want-list items of one intent into SectionRow shape (real price +
  // set; mocked delta for MVP, same as the other card lists). Opening the
  // popup uses the card's externalId (cardId).
  const wantRows = useMemo(() => {
    const toRows = (intent: "BUY" | "SELL" | "TRADE") =>
      wantItems
        .filter((w) => w.intent === intent)
        .map((w) => {
          const { delta, pct } = mockDelta(Math.random() > 0.5);
          return {
            name: w.name ?? w.cardId,
            sub: w.setName ?? "—",
            price: w.marketPrice != null ? fmt(w.marketPrice) : "—",
            delta,
            up: pct >= 0,
            card: {
              externalId: w.cardId,
              name: w.name ?? w.cardId,
              setName: w.setName ?? undefined,
              marketPrice: w.marketPrice,
            } as CardDetailsData,
          };
        });
    return { BUY: toRows("BUY"), SELL: toRows("SELL"), TRADE: toRows("TRADE") };
  }, [wantItems]);

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
          card: toPopupCard(item),
        };
      });

    // Collections: REAL named collections (F-10). Each owned copy carries
    // a `collectionId` (null = uncategorized). Aggregate count / graded /
    // value per named collection, plus an "Uncategorized" bucket for the
    // loose cards so nothing owned is hidden.
    const GRADED_RE = /\b(psa|bgs|cgc|sgc|beckett)\b/i;
    const nameById = new Map(collectionList.map((c) => [c.id, c.name]));
    const groups = new Map<string, { count: number; graded: number; value: number }>();
    for (const item of items) {
      const key = item.collectionId ?? "__uncat__";
      const g = groups.get(key) ?? { count: 0, graded: 0, value: 0 };
      g.count += item.quantity;
      if (item.condition && GRADED_RE.test(item.condition)) g.graded += item.quantity;
      g.value += (item.card.marketPrice ?? 0) * item.quantity;
      groups.set(key, g);
    }
    const collections = Array.from(groups.entries())
      .map(([key, data]) => {
        const { delta, pct } = mockDelta(Math.random() > 0.4);
        const name = key === "__uncat__" ? "Uncategorized" : nameById.get(key) ?? "Collection";
        return { key, name, ...data, delta, up: pct >= 0 };
      })
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);

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
          card: toPopupCard(item),
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
          card: toPopupCard(item),
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
  }, [collectionData, activeRange, collectionList]);

  // F-11: headline value / count / chart scoped to the selected collections.
  // Empty selection = all cards (no filter). Otherwise include only owned
  // copies whose collection membership is in the selected set (loose cards
  // ride the "__uncat__" sentinel).
  const scoped = useMemo(() => {
    const all = collectionData ?? [];
    const filtered =
      selectedIds.size === 0
        ? all
        : all.filter((i) => selectedIds.has(i.collectionId ?? "__uncat__"));

    let marketValue = 0;
    let cardCount = 0;
    for (const i of filtered) {
      marketValue += (i.card.marketPrice ?? 0) * i.quantity;
      cardCount += i.quantity;
    }
    marketValue = Math.round(marketValue * 100) / 100;

    // Range-aware sparkline; empty series when the scoped total is zero
    // (empty state → no line, no crash).
    const chartData = marketValue > 0 ? generateMockChartData(marketValue, activeRange) : [];
    return { marketValue, cardCount, chartData };
  }, [collectionData, selectedIds, activeRange]);

  // Selectable filter options: every named collection plus an
  // "Uncategorized" bucket for loose cards. Each gets a stable color square
  // (deterministic from index) matching the design's colored indicators.
  const COLL_COLORS = ["#E9B43B", "#0AC27E", "#2D7FF9", "#D400FF", "#EE9A1F", "#FF5A5A"];
  const collOptions = useMemo(() => {
    const opts = collectionList.map((c, i) => ({
      id: c.id,
      name: c.name,
      color: COLL_COLORS[i % COLL_COLORS.length],
    }));
    opts.push({ id: "__uncat__", name: "Uncategorized", color: "#9AA0A6" });
    return opts;
    // COLL_COLORS is a module-stable literal; only the list drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionList]);

  // Pill label: "All Collections" when nothing is filtered, the single
  // collection's name when exactly one is picked, else "N selected".
  const pillLabel = (() => {
    if (selectedIds.size === 0) return "All Collections";
    if (selectedIds.size === 1) {
      const only = [...selectedIds][0];
      return collOptions.find((o) => o.id === only)?.name ?? "1 selected";
    }
    return `${selectedIds.size} selected`;
  })();

  const toggleId = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Get card rows for the active tab (Collections is handled separately
  // since it renders CollectionRow, not SectionRow).
  const getActiveRows = () => {
    switch (activeTab) {
      case "mv": return stats.mostValuable;
      case "gain": return stats.gainers;
      case "lose": return stats.losers;
      case "buy": return wantRows.BUY;
      case "sell": return wantRows.SELL;
      case "trade": return wantRows.TRADE;
      default: return [];
    }
  };

  const getTabTitle = () => {
    switch (activeTab) {
      case "mv": return "Most valuable cards";
      case "coll": return "Your collections";
      case "gain": return "Top gainers this week";
      case "lose": return "Top losers this week";
      case "buy": return "Want to buy";
      case "sell": return "Want to sell";
      case "trade": return "Want to trade";
    }
  };

  // Empty-state copy per tab so a blank list reads clearly.
  const getEmptyText = () => {
    switch (activeTab) {
      case "buy": return "Nothing on your buy list yet";
      case "sell": return "Nothing on your sell list yet";
      case "trade": return "Nothing on your trade list yet";
      default: return "No cards yet";
    }
  };

  return (
    <div style={{ padding: "6px 22px 24px" }}>
      {hasCollection ? (
        /* ══════════ POPULATED STATE ══════════ */
        <>
          {/* ── Collection selector (F-11) — injected into the shell
              header's left slot so it shares one row with the search/bell
              icons. A compact pill that opens a multi-select filter panel
              (SELECT COLLECTIONS · checkbox + color square per item · DONE).
              Empty selection = all collections. */}
          <HeaderLeftSlot>
            <div style={{ position: "relative" }}>
              <button
                type="button"
                data-testid="collection-select"
                aria-haspopup="listbox"
                aria-expanded={collMenuOpen}
                onClick={() => setCollMenuOpen((v) => !v)}
                style={{
                  display: "inline-flex", alignItems: "center", gap: "8px",
                  padding: "7px 12px", cursor: "pointer",
                  border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)",
                  color: "var(--color-dojo-ink)",
                  fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px",
                  letterSpacing: "0.12em", textTransform: "uppercase", whiteSpace: "nowrap",
                }}
              >
                {pillLabel}
                <span aria-hidden="true" style={{ fontSize: "9px", opacity: 0.7 }}>▾</span>
              </button>

              {collMenuOpen && (
                <>
                  {/* Click-away scrim */}
                  <div
                    onClick={() => setCollMenuOpen(false)}
                    style={{ position: "fixed", inset: 0, zIndex: 60 }}
                  />
                  <div
                    role="listbox"
                    aria-label="Select collections"
                    style={{
                      position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 61,
                      minWidth: "240px", background: "var(--color-dojo-card)",
                      border: "1px solid var(--color-dojo-stroke)",
                      boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
                    }}
                  >
                    <div style={{ padding: "12px 14px 8px", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "9px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-faint)", borderBottom: "1px solid var(--color-dojo-divider)" }}>
                      Select Collections
                    </div>
                    <div style={{ maxHeight: "260px", overflowY: "auto" }}>
                      {collOptions.map((o) => {
                        const on = selectedIds.has(o.id);
                        return (
                          <button
                            key={o.id}
                            type="button"
                            role="option"
                            aria-selected={on}
                            onClick={() => toggleId(o.id)}
                            style={{
                              display: "flex", alignItems: "center", gap: "10px", width: "100%",
                              padding: "10px 14px", cursor: "pointer", background: "none", border: "none",
                              borderBottom: "1px solid var(--color-dojo-divider)", textAlign: "left",
                            }}
                          >
                            {/* Checkbox */}
                            <span
                              aria-hidden="true"
                              style={{
                                flex: "none", width: "16px", height: "16px",
                                border: "1px solid " + (on ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"),
                                background: on ? "var(--color-dojo-gold)" : "transparent",
                                color: "var(--color-dojo-app)", display: "flex", alignItems: "center", justifyContent: "center",
                                fontSize: "11px", fontWeight: 900,
                              }}
                            >
                              {on ? "✓" : ""}
                            </span>
                            {/* Color square indicator */}
                            <span aria-hidden="true" style={{ flex: "none", width: "10px", height: "10px", background: o.color }} />
                            <span style={{ flex: 1, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13px", color: "var(--color-dojo-ink)" }}>
                              {o.name}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <div style={{ padding: "10px 14px", display: "flex", justifyContent: "flex-end", gap: "12px", borderTop: "1px solid var(--color-dojo-divider)" }}>
                      <button
                        type="button"
                        onClick={() => setSelectedIds(new Set())}
                        style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}
                      >
                        Clear
                      </button>
                      <button
                        type="button"
                        onClick={() => setCollMenuOpen(false)}
                        style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "9.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-gold)" }}
                      >
                        Done
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </HeaderLeftSlot>

          {/* ── Portfolio value + eye toggle ── */}
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "16px" }}>
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontStretch: "112%", fontSize: "10px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
              Portfolio value
            </span>
            <span data-testid="card-count" style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
              {scoped.cardCount} {scoped.cardCount === 1 ? "card" : "cards"}
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
              {hidden ? `$ ${mask}${mask}` : fmt(scoped.marketValue)}
            </div>
            {/* Only the % delta here — the active period is already shown
                (and highlighted) by the range-tab row directly below, so
                repeating it caused the "1M 1M" duplication (Phase 2 QA). */}
            <div style={{ flex: "none", paddingBottom: "6px", display: "flex", alignItems: "baseline", gap: "7px" }}>
              <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-jade)" }}>
                ▲ {hidden ? mask : `+${fmt(stats.overallDelta)}`} · {stats.overallPct}%
              </span>
            </div>
          </div>

          {/* ── Paid / Realized / Unrealized ── */}
          <div style={{ display: "flex", gap: "12px", marginTop: "12px", paddingTop: "12px", borderTop: "1px solid var(--color-dojo-divider)", flexWrap: "nowrap", whiteSpace: "nowrap", overflowX: "auto" }}>
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
              Paid <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12.5px", letterSpacing: 0, color: "var(--color-dojo-ink)" }}>{hidden ? mask : fmt(stats.paid)}</span>
            </span>
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
              Realized <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12.5px", letterSpacing: 0, color: "var(--color-dojo-jade)" }}>{hidden ? mask : `+${fmt(0)}`}</span>
            </span>
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
              Unrealized <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12.5px", letterSpacing: 0, color: stats.unrealized >= 0 ? "var(--color-dojo-jade)" : "var(--color-dojo-vermilion)" }}>{hidden ? mask : `${stats.unrealized >= 0 ? "+" : ""}${fmt(stats.unrealized)}`}</span>
            </span>
          </div>

          {/* ── Chart — inline SVG area line.
              The data has always been mock (see generateMockChartData);
              recharts was pulling in ~90 kB of d3 modules just to render
              a stroke + gradient we can draw in 30 lines of SVG. When
              real PricingHistory data lands (Week 3), swap `data` for
              the query result — everything below already takes an
              array of `{ value: number }`. */}
          <div style={{ margin: "16px -22px 0", height: "200px" }}>
            {scoped.chartData.length > 0 ? (
              <MiniAreaChart
                data={scoped.chartData}
                formatValue={(v) => (hidden ? `$ ${mask}` : fmt(v))}
              />
            ) : (
              // F-11 empty state: selected collection has no cards. Show a
              // calm placeholder rather than a blank/flat chart or a crash.
              <div
                data-testid="empty-chart"
                style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-dojo-faint)", fontFamily: "var(--font-display)", fontSize: "12px", letterSpacing: "0.08em", textTransform: "uppercase" }}
              >
                No cards in this collection yet
              </div>
            )}
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

          {/* ── Tab selector — horizontally scrollable pill row. Active
              tab is gold-highlighted with a gold underline (task 4). ── */}
          <div className="dojo-scroll-hidden" style={{ display: "flex", gap: "8px", overflowX: "auto", marginTop: "20px", paddingBottom: "2px" }}>
            {TABS.map((tab) => {
              const on = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  aria-pressed={on}
                  style={{
                    flex: "none", whiteSpace: "nowrap", padding: "9px 12px", cursor: "pointer",
                    border: "1px solid " + (on ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"),
                    borderBottom: on ? "2px solid var(--color-dojo-gold)" : "1px solid var(--color-dojo-stroke)",
                    fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase",
                    background: on ? "var(--color-dojo-gold)" : "transparent",
                    color: on ? "var(--color-dojo-app)" : "var(--color-dojo-body)",
                    boxShadow: "none",
                  }}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* ── Tab content ── */}
          <div style={{ marginTop: "12px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "2px 15px 6px" }}>
            <div style={{ display: "flex", alignItems: "center", padding: "14px 0" }}>
              <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
                {getTabTitle()}
              </span>
              {/* "ALL ›" deep-links to the fuller view for the active tab:
                  collections → /you (manager), want tabs → /wantlist,
                  card lists → /portfolio. */}
              <Link
                href={
                  activeTab === "coll" ? "/you"
                  : activeTab === "buy" || activeTab === "sell" || activeTab === "trade" ? "/wantlist"
                  : "/portfolio"
                }
                style={{ marginLeft: "auto", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-gold)", textDecoration: "none" }}
              >
                All ›
              </Link>
            </div>

            {activeTab === "coll" ? (
              /* Collections tab — real named collections (F-10) */
              stats.collections.length > 0 ? (
                stats.collections.map(({ key, ...coll }) => (
                  <CollectionRow key={key} {...coll} />
                ))
              ) : (
                <div style={{ padding: "20px 0", textAlign: "center", color: "var(--color-dojo-faint)", fontSize: "12px" }}>
                  No collections yet
                </div>
              )
            ) : (
              /* Card lists — Most valuable / Gainers / Losers / Want to Buy/Sell/Trade */
              getActiveRows().length > 0 ? (
                getActiveRows().map(({ card, ...row }, i) => (
                  <SectionRow key={`${row.name}-${i}`} {...row} onOpen={() => setPopupCard(card)} />
                ))
              ) : (
                <div style={{ padding: "20px 0", textAlign: "center", color: "var(--color-dojo-faint)", fontSize: "12px" }}>
                  {getEmptyText()}
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
            {/* F-01: removed the duplicate search/bell icons here — the
                global shell header already provides them. */}
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

          <div style={{ background: "var(--color-dojo-gold)", boxShadow: "6px 6px 0 0 var(--color-dojo-btn-shadow)", padding: "19px 20px", margin: "20px 6px 6px 0" }}>
            <p style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "15px", color: "var(--color-dojo-app)", margin: 0 }}>
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
                  background: "var(--color-dojo-app)", color: "var(--color-dojo-ink)",
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
                  color: "var(--color-dojo-app)", textDecoration: "none",
                }}
              >
                Search ›
              </Link>
            </div>
          </div>
        </>
      )}

      {/* F-08: card details popup — opens when a Most Valuable / Gainers /
          Losers row is clicked. Add-to-collection routes the user to the
          search flow (the dashboard has no inline add sheet). */}
      {popupCard && (
        <CardDetailsPopup
          card={popupCard}
          onClose={() => setPopupCard(null)}
          onAddToCollection={() => {
            window.location.href = "/search";
          }}
        />
      )}
    </div>
  );
}
