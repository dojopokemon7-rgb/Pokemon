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
  isSold?: boolean;
  soldPrice?: number | null;
  soldAt?: Date | string | null;
  card: {
    id: string;
    externalId?: string;
    name: string;
    marketPrice: number | null;
    set: { name: string } | null;
  };
}

// F-08: map a collection row to the shape the details popup needs.
function toPopupCard(item: CollectionItem): CardDetailsData {
  return {
    externalId: item.card.externalId || item.cardId,
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

function generateMockChartData(baseValue: number, range: RangeId, seedOffset: number = 0): { value: number }[] {
  const { startFraction, volatility, trend, points, seed } = RANGE_SHAPES[range];
  const rand = mulberry32(seed + seedOffset);
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

// Deterministic mock delta — seeded by a stable string (e.g. item id) so
// SSR and client render the SAME value and React hydration doesn't mismatch.
// TODO Week 3: Replace with real PricingHistory delta calculations.
function seededFrac(seed: string): number {
  // FNV-1a 32-bit hash → [0, 1)
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 4294967296);
}

function mockDelta(positive: boolean, seed: string = ""): { delta: string; pct: number } {
  const r = seededFrac(seed || "default");
  const pct = positive
    ? 1 + r * 8    // +1% to +9%
    : -(0.5 + r * 4); // -0.5% to -4.5%
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

// ── Multi-Line SVG Comparison Chart ────────────────────────────────
export interface CollectionSeries {
  id: string;
  name: string;
  color: string;
  data: readonly { value: number }[];
}

function MultiLineComparisonChart({
  seriesList,
  focusedId,
  formatValue,
}: {
  seriesList: CollectionSeries[];
  focusedId?: string | null;
  formatValue?: (v: number) => string;
}) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  if (seriesList.length === 0 || seriesList.every((s) => s.data.length < 2)) {
    return (
      <div
        data-testid="empty-chart"
        style={{
          height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
          color: "var(--color-dojo-faint)", fontFamily: "var(--font-display)", fontSize: "12px",
          letterSpacing: "0.08em", textTransform: "uppercase"
        }}
      >
        No cards in this collection yet
      </div>
    );
  }

  const W = 400;
  const H = 200;

  // Global bounds across all series for aligned comparison
  const allValues = seriesList.flatMap((s) => s.data.map((d) => d.value));
  const rawMin = Math.min(...allValues);
  const rawMax = Math.max(...allValues);
  const pad = (rawMax - rawMin) * 0.08 || 1;
  const min = Math.max(0, rawMin - pad);
  const max = rawMax + pad;
  const range = max - min || 1;

  const pointsCount = seriesList[0]?.data.length || 2;
  const step = W / (pointsCount - 1);
  const y = (v: number) => H - ((v - min) / range) * (H - 24) - 12;

  const idxFromClientX = (clientX: number): number => {
    const el = wrapRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(frac * (pointsCount - 1));
  };

  const handleMove = (clientX: number) => setActiveIdx(idxFromClientX(clientX));
  const clear = () => setActiveIdx(null);

  const activeXFrac = activeIdx != null ? activeIdx / (pointsCount - 1) : 0;
  const fmtV = formatValue ?? ((v: number) => `$${Math.round(v).toLocaleString()}`);
  const isSingle = seriesList.length === 1;

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
      aria-label="Portfolio comparison chart"
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        width="100%"
        height="100%"
        aria-hidden="true"
      >
        <defs>
          {seriesList.map((s) => (
            <linearGradient key={`grad-${s.id}`} id={`dojoGrad-${s.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.25} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>

        {/* If single series, draw subtle gradient fill */}
        {isSingle && (
          <path
            d={
              `M0,${H} L` +
              seriesList[0].data.map((d, i) => `${i * step},${y(d.value)}`).join(" L") +
              ` L${W},${H} Z`
            }
            fill={`url(#dojoGrad-${seriesList[0].id})`}
          />
        )}

        {/* Multi-line comparison polylines */}
        {seriesList.map((s) => {
          const isFocused = focusedId === s.id;
          const strokeWidth = isFocused ? 3.0 : focusedId ? 1.6 : 2.4;
          const opacity = isFocused ? 1 : focusedId ? 0.45 : 1;
          const linePoints = s.data
            .map((d, i) => `${i * step},${y(d.value)}`)
            .join(" ");

          return (
            <polyline
              key={s.id}
              points={linePoints}
              fill="none"
              stroke={s.color}
              strokeWidth={strokeWidth}
              opacity={opacity}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}

        {/* Vertical guide line on hover */}
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

      {/* Marker dots */}
      {activeIdx != null &&
        seriesList.map((s) => {
          const val = s.data[activeIdx]?.value ?? 0;
          const isFocused = focusedId === s.id;
          return (
            <span
              key={`dot-${s.id}`}
              aria-hidden
              style={{
                position: "absolute",
                left: `${activeXFrac * 100}%`,
                top: `${(y(val) / H) * 100}%`,
                width: isFocused ? 11 : 8,
                height: isFocused ? 11 : 8,
                marginLeft: isFocused ? -5.5 : -4,
                marginTop: isFocused ? -5.5 : -4,
                borderRadius: "50%",
                background: s.color,
                boxShadow: `0 0 0 2px rgba(0,0,0,0.8), 0 0 8px ${s.color}`,
                pointerEvents: "none",
                zIndex: isFocused ? 5 : 4,
              }}
            />
          );
        })}

      {/* Floating tooltip */}
      {activeIdx != null && (
        <div
          style={{
            position: "absolute",
            left: `${Math.min(78, Math.max(22, activeXFrac * 100))}%`,
            top: 4,
            transform: "translateX(-50%)",
            background: "rgba(18, 18, 18, 0.95)",
            backdropFilter: "blur(6px)",
            border: "1px solid var(--color-dojo-stroke)",
            padding: "6px 10px",
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: "11px",
            color: "var(--color-dojo-ink)",
            whiteSpace: "nowrap",
            pointerEvents: "none",
            boxShadow: "0 6px 18px rgba(0,0,0,0.6)",
            zIndex: 10,
          }}
        >
          {seriesList.map((s) => {
            const val = s.data[activeIdx]?.value ?? 0;
            return (
              <div key={`tip-${s.id}`} style={{ display: "flex", alignItems: "center", gap: "6px", lineHeight: "1.4" }}>
                <span style={{ width: "7px", height: "7px", background: s.color, flex: "none" }} />
                <span style={{ color: "var(--color-dojo-body)", fontSize: "10px" }}>{s.name}:</span>
                <span style={{ fontVariantNumeric: "tabular-nums", color: s.color }}>{fmtV(val)}</span>
              </div>
            );
          })}
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Focused collection for stat card / chart highlight (null = combined).
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // Whether the selector dropdown panel is open.
  const [collMenuOpen, setCollMenuOpen] = useState(false);
  // F-08: the card whose details popup is open (null = closed).
  const [popupCard, setPopupCard] = useState<CardDetailsData | null>(null);

  // suppressHydrationWarning on the element that renders this — locale
  // formatting can differ between Node and browser, which is intentional.
  const dateString = `${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} · Markets open`;

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
          // Seed includes the id + intent so BUY and SELL deltas differ for same card
          const seed = `want-${w.id}-${intent}`;
          const positive = seededFrac(seed + "dir") > 0.5;
          const { delta, pct } = mockDelta(positive, seed);
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

  // Selectable filter options: every named collection plus an
  // "Uncategorized" / "Main" bucket and "Want to buy" tracker.
  // Colors match Image 1: Main (#E9B43B Gold), Want to buy (#0AC27E Mint),
  // High value tracker (#2D7FF9 Blue), followed by palette colors.
  const COLL_COLORS = ["#E9B43B", "#0AC27E", "#2D7FF9", "#D400FF", "#EE9A1F", "#FF5A5A", "#00C9A7", "#845EC2"];
  const collOptions = useMemo(() => {
    const activeItems = (collectionData ?? []).filter((i) => !i.isSold);
    const soldItems = (collectionData ?? []).filter((i) => i.isSold);

    // Val maps per collection
    const mValMap = new Map<string, number>();
    const paidMap = new Map<string, number>();
    const countMap = new Map<string, number>();
    for (const item of activeItems) {
      const key = item.collectionId ?? "__uncat__";
      mValMap.set(key, (mValMap.get(key) ?? 0) + (item.card.marketPrice ?? 0) * item.quantity);
      paidMap.set(key, (paidMap.get(key) ?? 0) + (item.purchasePrice ?? 0) * item.quantity);
      countMap.set(key, (countMap.get(key) ?? 0) + item.quantity);
    }

    const realMap = new Map<string, number>();
    for (const item of soldItems) {
      const key = item.collectionId ?? "__uncat__";
      const profit = ((item.soldPrice ?? 0) - (item.purchasePrice ?? 0)) * item.quantity;
      realMap.set(key, (realMap.get(key) ?? 0) + profit);
    }

    const opts: {
      id: string;
      name: string;
      color: string;
      marketValue: number;
      paid: number;
      realized: number;
      cardCount: number;
    }[] = [];

    // Loose cards bucket ("Main" if no collection is named Main, else "Uncategorized")
    const hasNamedMain = collectionList.some((c) => c.name.toLowerCase() === "main");
    opts.push({
      id: "__uncat__",
      name: hasNamedMain ? "Uncategorized" : "Main",
      color: "#E9B43B", // Gold for Main
      marketValue: mValMap.get("__uncat__") ?? 0,
      paid: paidMap.get("__uncat__") ?? 0,
      realized: realMap.get("__uncat__") ?? 0,
      cardCount: countMap.get("__uncat__") ?? 0,
    });

    // "Want to buy" tracking collection (matches Image 1: #0AC27E Mint, $2,481)
    const hasNamedWant = collectionList.some((c) => c.name.toLowerCase().includes("want to buy"));
    if (!hasNamedWant) {
      const wantBuyTotal = wantItems
        .filter((w) => w.intent === "BUY" && w.marketPrice != null)
        .reduce((sum, w) => sum + (w.marketPrice ?? 0), 0);
      opts.push({
        id: "__want_buy__",
        name: "Want to buy",
        color: "#0AC27E", // Mint green
        marketValue: wantBuyTotal > 0 ? wantBuyTotal : 0,
        paid: Math.round(wantBuyTotal * 0.74), // realistic purchase target
        realized: 0,
        cardCount: wantItems.filter((w) => w.intent === "BUY").length,
      });
    }

    // Named collections from database
    const namedPalette = ["#2D7FF9", "#D400FF", "#EE9A1F", "#FF5A5A", "#00C9A7", "#845EC2"];
    collectionList.forEach((c, i) => {
      opts.push({
        id: c.id,
        name: c.name,
        color: namedPalette[i % namedPalette.length],
        marketValue: mValMap.get(c.id) ?? 0,
        paid: paidMap.get(c.id) ?? 0,
        realized: realMap.get(c.id) ?? 0,
        cardCount: countMap.get(c.id) ?? 0,
      });
    });

    return opts;
  }, [collectionList, collectionData, wantItems]);

  // Active selected ids (empty set = all collections selected by default)
  const activeSelectedIds = useMemo(() => {
    return selectedIds.size === 0 ? new Set(collOptions.map((o) => o.id)) : selectedIds;
  }, [selectedIds, collOptions]);

  const activeSelectedOptions = useMemo(() => {
    return collOptions.filter((o) => activeSelectedIds.has(o.id));
  }, [collOptions, activeSelectedIds]);

  // Pill label matching Image 1: "3 COLLECTIONS ▾" when 3 selected, or single name
  const pillLabel = (() => {
    if (activeSelectedIds.size === 1) {
      const only = activeSelectedOptions[0];
      return only ? `${only.name} ▾` : "1 Collection ▾";
    }
    return `${activeSelectedIds.size} COLLECTIONS ▾`;
  })();

  const toggleId = (id: string) => {
    setSelectedIds((prev) => {
      const current = prev.size === 0 ? new Set(collOptions.map((o) => o.id)) : new Set(prev);
      if (current.has(id)) {
        current.delete(id);
      } else {
        current.add(id);
      }
      if (current.size === collOptions.length) {
        return new Set();
      }
      return current;
    });
  };

  // ── Computed stats from REAL data ────────────────────────────────
  const stats = useMemo(() => {
    const items = (collectionData ?? []).filter((i) => !i.isSold);
    const soldItems = (collectionData ?? []).filter((i) => i.isSold);

    const marketValue = items.reduce(
      (sum, i) => sum + (i.card.marketPrice ?? 0) * i.quantity, 0
    );
    const paid = items.reduce(
      (sum, i) => sum + (i.purchasePrice ?? 0) * i.quantity, 0
    );
    const realized = soldItems.reduce(
      (sum, i) => sum + ((i.soldPrice ?? 0) - (i.purchasePrice ?? 0)) * i.quantity, 0
    );
    const unrealized = marketValue - paid;

    // Most valuable: top 5 by value (REAL cards, mocked deltas, formatted like Image 1)
    const mostValuable = [...items]
      .sort((a, b) => (b.card.marketPrice ?? 0) * b.quantity - (a.card.marketPrice ?? 0) * a.quantity)
      .slice(0, 5)
      .map((item) => {
        // Seed by stable id — deterministic on both server and client
        const seed = `mv-${item.id}`;
        const { delta, pct } = mockDelta(seededFrac(seed + "dir") > 0.3, seed);
        const conditionStr = item.condition ? item.condition : "Raw";
        const setStr = item.card.set?.name ?? "";
        const foilStr = item.isFoil ? "Foil" : "";
        const subParts = [conditionStr];
        if (setStr && conditionStr.toLowerCase() !== setStr.toLowerCase()) subParts.push(setStr);
        if (foilStr) subParts.push(foilStr);
        const sub = subParts.join(" · ");
        return {
          name: item.card.name,
          sub,
          price: fmt((item.card.marketPrice ?? 0) * item.quantity),
          delta,
          up: pct >= 0,
          card: toPopupCard(item),
        };
      });

    // Collections: REAL named collections (F-10)
    const collections = collOptions.map((opt) => {
      const seed = `coll-${opt.id}`;
      const { delta, pct } = mockDelta(seededFrac(seed + "dir") > 0.4, seed);
      return {
        key: opt.id,
        name: opt.name,
        count: opt.cardCount,
        graded: 0,
        value: opt.marketValue,
        delta,
        up: pct >= 0,
      };
    });

    // Gainers & Losers
    const gainers = [...items]
      .sort((a, b) => (b.card.marketPrice ?? 0) - (a.card.marketPrice ?? 0))
      .slice(0, 5)
      .map((item) => {
        const { delta } = mockDelta(true, `gain-${item.id}`);
        const sub = `${item.condition || item.card.set?.name || "Raw"} · Qty ${item.quantity}`;
        return {
          name: item.card.name,
          sub,
          price: fmt((item.card.marketPrice ?? 0) * item.quantity),
          delta,
          up: true,
          card: toPopupCard(item),
        };
      });

    const losers = [...items]
      .sort((a, b) => (a.card.marketPrice ?? 0) - (b.card.marketPrice ?? 0))
      .slice(0, 5)
      .map((item) => {
        const { delta } = mockDelta(false, `lose-${item.id}`);
        const sub = `${item.condition || item.card.set?.name || "Raw"} · Qty ${item.quantity}`;
        return {
          name: item.card.name,
          sub,
          price: fmt((item.card.marketPrice ?? 0) * item.quantity),
          delta,
          up: false,
          card: toPopupCard(item),
        };
      });

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

    return { marketValue, paid, realized, unrealized, mostValuable, collections, gainers, losers, overallPct, overallDelta };
  }, [collectionData, activeRange, collOptions]);

  // Focused / active stat metrics for the top card (matching Image 1)
  const activeStat = useMemo(() => {
    if (focusedId && activeSelectedIds.has(focusedId)) {
      const opt = collOptions.find((o) => o.id === focusedId);
      if (opt) {
        const overallDelta = opt.marketValue * (stats.overallPct / 100);
        return {
          name: opt.name,
          color: opt.color,
          marketValue: opt.marketValue,
          paid: opt.paid,
          realized: opt.realized,
          cardCount: opt.cardCount,
          overallDelta,
        };
      }
    }

    // Combined across selected options
    let mVal = 0;
    let pVal = 0;
    let rVal = 0;
    let count = 0;
    for (const opt of activeSelectedOptions) {
      mVal += opt.marketValue;
      pVal += opt.paid;
      rVal += opt.realized;
      count += opt.cardCount;
    }
    const overallDelta = mVal * (stats.overallPct / 100);
    const isSingle = activeSelectedOptions.length === 1;
    return {
      name: isSingle ? activeSelectedOptions[0].name : `${activeSelectedOptions.length} COLLECTIONS`,
      color: isSingle ? activeSelectedOptions[0].color : "var(--color-dojo-gold)",
      marketValue: mVal,
      paid: pVal,
      realized: rVal,
      cardCount: count,
      overallDelta,
    };
  }, [focusedId, activeSelectedIds, collOptions, activeSelectedOptions, stats.overallPct]);

  // Multi-line chart series: one curve per selected collection ending at its market value
  const chartSeriesList = useMemo(() => {
    return activeSelectedOptions.map((opt, idx) => {
      const data = opt.marketValue > 0
        ? generateMockChartData(opt.marketValue, activeRange, idx * 37)
        : [{ value: 0 }, { value: 0 }];
      return {
        id: opt.id,
        name: opt.name,
        color: opt.color,
        data,
      };
    });
  }, [activeSelectedOptions, activeRange]);

  // Active tab card rows
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
          {/* ── Collection selector (F-11) — header slot dropdown pill ── */}
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
              </button>

              {collMenuOpen && (
                <>
                  {/* Click-away scrim */}
                  <div
                    onClick={() => setCollMenuOpen(false)}
                    style={{ position: "fixed", inset: 0, zIndex: 60 }}
                  />
                  {/* Popover modal matching Image 1: SELECT COLLECTIONS, checkboxes, colors, values, and bold gold DONE */}
                  <div
                    role="listbox"
                    aria-label="Select collections"
                    style={{
                      position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 61,
                      minWidth: "270px", background: "var(--color-dojo-card)",
                      border: "1px solid var(--color-dojo-stroke)",
                      boxShadow: "0 12px 36px rgba(0,0,0,0.75)",
                    }}
                  >
                    <div style={{ padding: "12px 16px 8px", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "9px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-faint)", borderBottom: "1px solid var(--color-dojo-divider)" }}>
                      Select Collections
                    </div>
                    <div style={{ maxHeight: "280px", overflowY: "auto" }}>
                      {collOptions.map((o) => {
                        const on = activeSelectedIds.has(o.id);
                        return (
                          <button
                            key={o.id}
                            type="button"
                            role="option"
                            aria-selected={on}
                            onClick={() => toggleId(o.id)}
                            style={{
                              display: "flex", alignItems: "center", gap: "10px", width: "100%",
                              padding: "11px 16px", cursor: "pointer", background: "none", border: "none",
                              borderBottom: "1px solid var(--color-dojo-divider)", textAlign: "left",
                            }}
                          >
                            {/* Checkbox matching Image 1 */}
                            <span
                              aria-hidden="true"
                              style={{
                                flex: "none", width: "16px", height: "16px",
                                border: "1px solid " + (on ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"),
                                background: on ? "var(--color-dojo-gold)" : "transparent",
                                color: "#000000", display: "flex", alignItems: "center", justifyContent: "center",
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
                            {/* Collection value on right */}
                            <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12.5px", fontVariantNumeric: "tabular-nums", color: "var(--color-dojo-faint)" }}>
                              {fmt(o.marketValue)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {/* Centered bold gold DONE button matching Image 1 */}
                    <div style={{ padding: "10px 16px", textAlign: "center", borderTop: "1px solid var(--color-dojo-divider)" }}>
                      <button
                        type="button"
                        onClick={() => setCollMenuOpen(false)}
                        style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px", letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--color-dojo-gold)", width: "100%", padding: "4px 0" }}
                      >
                        Done
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </HeaderLeftSlot>

          {/* ── Stat Card (Collectr-style matching Image 1) ── */}
          <div style={{ background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "16px 18px", marginTop: "14px" }}>
            {/* Header: Collection indicator + Eye toggle */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
                <span style={{ width: 8, height: 8, background: activeStat.color, flex: "none" }} />
                <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "10.5px", letterSpacing: "0.16em", textTransform: "uppercase", color: activeStat.color }}>
                  {activeStat.name}
                </span>
                <span data-testid="card-count" style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)", marginLeft: "4px" }}>
                  · {activeStat.cardCount} {activeStat.cardCount === 1 ? "card" : "cards"}
                </span>
              </div>
              <button
                onClick={() => setHidden((v) => !v)}
                title={hidden ? "Show values" : "Hide values"}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "22px", height: "22px", cursor: "pointer", background: "none", border: "none", color: "var(--color-dojo-body)" }}
              >
                <EyeIcon off={hidden} />
              </button>
            </div>

            {/* Market Value label */}
            <div style={{ marginTop: "10px", fontFamily: "var(--font-display)", fontWeight: 700, fontStretch: "112%", fontSize: "9.5px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
              Market Value
            </div>

            {/* Big Value + Delta */}
            <div style={{ marginTop: "4px", display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "12px" }}>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "38px", lineHeight: 1.05, fontVariantNumeric: "tabular-nums", color: "var(--color-dojo-ink)" }}>
                {hidden ? `$ ${mask}${mask}` : fmt(activeStat.marketValue)}
              </div>
              <div style={{ paddingBottom: "4px" }}>
                <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-jade)" }}>
                  ▲ {hidden ? mask : `+${fmt(activeStat.overallDelta)}`} · {stats.overallPct}%
                </span>
              </div>
            </div>

            {/* Paid / Realized / Unrealized row matching Image 1 */}
            <div style={{ display: "flex", gap: "28px", marginTop: "14px", paddingTop: "12px", borderTop: "1px solid var(--color-dojo-divider)" }}>
              <div>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
                  PAID
                </div>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "15px", color: "var(--color-dojo-ink)", marginTop: "4px", fontVariantNumeric: "tabular-nums" }}>
                  {hidden ? mask : fmt(activeStat.paid)}
                </div>
              </div>
              <div>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
                  REALIZED
                </div>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "15px", color: activeStat.realized >= 0 ? "var(--color-dojo-jade)" : "var(--color-dojo-vermilion)", marginTop: "4px", fontVariantNumeric: "tabular-nums" }}>
                  {hidden ? mask : `${activeStat.realized >= 0 ? "+" : ""}${fmt(activeStat.realized)}`}
                </div>
              </div>
            </div>
          </div>

          {/* ── Collection focus quick-switch pills (when multiple selected) ── */}
          {activeSelectedOptions.length > 1 && (
            <div className="dojo-scroll-hidden" style={{ display: "flex", gap: "8px", overflowX: "auto", marginTop: "12px", paddingBottom: "2px" }}>
              <button
                type="button"
                onClick={() => setFocusedId(null)}
                style={{
                  flex: "none", display: "inline-flex", alignItems: "center", gap: "6px",
                  padding: "5px 10px", cursor: "pointer",
                  background: focusedId === null ? "rgba(233,180,59,0.12)" : "var(--color-dojo-card)",
                  border: "1px solid " + (focusedId === null ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"),
                  color: focusedId === null ? "var(--color-dojo-gold)" : "var(--color-dojo-faint)",
                  fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase",
                }}
              >
                All Selected
              </button>
              {activeSelectedOptions.map((o) => {
                const isFocused = focusedId === o.id;
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => setFocusedId(isFocused ? null : o.id)}
                    style={{
                      flex: "none", display: "inline-flex", alignItems: "center", gap: "6px",
                      padding: "5px 10px", cursor: "pointer",
                      background: isFocused ? "rgba(255,255,255,0.08)" : "var(--color-dojo-card)",
                      border: "1px solid " + (isFocused ? o.color : "var(--color-dojo-stroke)"),
                      color: isFocused ? o.color : "var(--color-dojo-body)",
                      fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9px", letterSpacing: "0.12em", textTransform: "uppercase",
                    }}
                  >
                    <span style={{ width: 7, height: 7, background: o.color }} />
                    {o.name}
                  </button>
                );
              })}
            </div>
          )}

          {/* ── Multi-Line Comparison Chart ── */}
          <div style={{ margin: "16px -22px 0", height: "200px" }}>
            <MultiLineComparisonChart
              seriesList={chartSeriesList}
              focusedId={focusedId}
              formatValue={(v) => (hidden ? `$ ${mask}` : fmt(v))}
            />
          </div>

          {/* ── Range selector tabs with centered gold underline bar ── */}
          <div style={{ display: "flex", borderBottom: "1px solid var(--color-dojo-divider)", marginTop: "8px" }}>
            {RANGES.map((r) => {
              const on = activeRange === r;
              return (
                <button
                  key={r}
                  onClick={() => setActiveRange(r)}
                  style={{
                    flex: 1, textAlign: "center", padding: "10px 0 8px", cursor: "pointer",
                    background: "transparent", border: "none", position: "relative",
                    fontFamily: "var(--font-display)", fontWeight: on ? 800 : 700, fontSize: "10px", letterSpacing: "0.14em",
                    color: on ? "var(--color-dojo-ink)" : "var(--color-dojo-faint)",
                  }}
                >
                  {r}
                  {on && (
                    <span
                      style={{
                        position: "absolute", bottom: -1, left: "22%", right: "22%",
                        height: "2.5px", background: "var(--color-dojo-gold)",
                      }}
                    />
                  )}
                </button>
              );
            })}
          </div>

          {/* ── Tab selector — solid gold active tab matching Image 1 ── */}
          <div className="dojo-scroll-hidden" style={{ display: "flex", gap: "8px", overflowX: "auto", marginTop: "20px", paddingBottom: "2px" }}>
            {TABS.map((tab) => {
              const on = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  aria-pressed={on}
                  style={{
                    flex: "none", whiteSpace: "nowrap", padding: "10px 16px", cursor: "pointer",
                    border: on ? "1px solid var(--color-dojo-gold)" : "1px solid var(--color-dojo-stroke)",
                    fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "9.5px", letterSpacing: "0.12em", textTransform: "uppercase",
                    background: on ? "var(--color-dojo-gold)" : "var(--color-dojo-card)",
                    color: on ? "#0D0D0D" : "var(--color-dojo-body)",
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
              <p suppressHydrationWarning style={{ marginTop: "8px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
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
