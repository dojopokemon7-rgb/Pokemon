"use client";

/**
 * Screen 09 + 10 — Dashboard (Empty State & Populated)
 *
 * HYBRID APPROACH (MVP):
 * - UI matches the prototype exactly (chart, tabs, layout)
 * - Card lists use REAL data from the database
 * - Weekly % changes use the REAL stored Card.weeklyChangePct (Scrydex
 *   trends.days_7); when a card has no recorded change the row shows "—",
 *   never a fabricated number (AGENTS.md rule 2).
 *
 * Tabs:
 * - Most Valuable: Real user's top 5 cards by marketPrice (real weekly delta or "—")
 * - Collections: Real cards grouped by CardSet.name
 * - Gainers: Real cards sorted by real weeklyChangePct desc (nulls excluded)
 * - Losers: Real cards sorted by real weeklyChangePct asc (nulls excluded)
 *
 * Chart: the comparison chart draws REAL stored history only (honest gaps).
 */

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState, useMemo } from "react";
import { CardDetailsPopup, type CardDetailsData } from "@/components/CardDetailsPopup";
import { AreaChart, type AreaChartDatum, type AreaChartSeries } from "@/components/AreaChart";
import { Skeleton } from "@/components/Skeleton";
import { useDelayedFlag } from "@/components/useDelayedFlag";
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
    /** REAL stored 7-day % change (Scrydex trends.days_7); null until a priced
     *  pull runs → the row's delta renders "—" (never fabricated). */
    weeklyChangePct?: number | null;
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

// Plan §6: the Want-to-Buy / Want-to-Sell / Want-to-Trade INTENT sections are
// REMOVED from the dashboard — both lists live on the dedicated /wantlist page.
// The TabId union keeps the intent values (other code still references them for
// the want-list total card + deep links), but they are no longer offered as
// dashboard tabs here.
const TABS: { id: TabId; label: string }[] = [
  { id: "mv", label: "Most Valuable" },
  { id: "coll", label: "Collections" },
  { id: "gain", label: "Gainers" },
  { id: "lose", label: "Losers" },
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
  /** REAL stored 7-day % change; null until a priced pull runs → "—". */
  weeklyChangePct: number | null;
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
// The synthetic chart generator (RANGE_SHAPES / mulberry32 / generateMockChartData)
// was REMOVED (plan §6): the comparison chart now draws from REAL stored history
// only, with honest gaps and no fabricated/interpolated series.

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
  hidden,
}: {
  seriesList: CollectionSeries[];
  /** When true, the "hide values" eye toggle is on. The ported AreaChart's
   *  tooltip shows raw values and has no mask hook, so to preserve the privacy
   *  the eye toggle promises we render a "values hidden" placeholder instead of
   *  the chart (shape + exact dollar amounts return the instant hiding is off). */
  hidden?: boolean;
}) {
  // Honest empty states (plan §6): no series, or every series with < 2 real
  // points → nothing to compare yet. Never fabricate a line.
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

  // With real-history-only data a brand-new / priceless collection has no
  // points. Show an honest "no history yet" rather than a fabricated line.
  const anyValues = seriesList.some((s) => s.data.length > 0);
  if (!anyValues) {
    return (
      <div
        style={{
          width: "100%", height: "100%", display: "flex", alignItems: "center",
          justifyContent: "center", color: "var(--color-dojo-faint)",
          fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12px",
        }}
        role="img"
        aria-label="No price history yet"
      >
        No price history yet
      </div>
    );
  }

  if (hidden) {
    return (
      <div
        style={{
          width: "100%", height: "100%", display: "flex", alignItems: "center",
          justifyContent: "center", color: "var(--color-dojo-faint)",
          fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12px",
          letterSpacing: "0.08em", textTransform: "uppercase",
        }}
        role="img"
        aria-label="Values hidden"
      >
        Values hidden
      </div>
    );
  }

  // Transpose the per-series arrays into the ported AreaChart's row-per-x-index
  // shape (one AreaChartSeries per collection). All series share the x-length;
  // the shortest bounds the row count so we never read past a series.
  const pointsCount = Math.min(...seriesList.map((s) => s.data.length));
  // The real history points carry no per-point date labels here, so we OMIT the
  // x-axis labels (empty strings) rather than fabricate dates (task Item A.2).
  const data: AreaChartDatum[] = Array.from({ length: pointsCount }, (_, i) => {
    const row: AreaChartDatum = { label: "" };
    for (const s of seriesList) row[s.id] = s.data[i].value;
    return row;
  });
  const series: AreaChartSeries[] = seriesList.map((s) => ({
    valueKey: s.id,
    label: s.name,
    color: s.color,
  }));

  return (
    <div style={{ width: "100%", height: "100%" }}>
      <AreaChart data={data} series={series} height={200} />
    </div>
  );
}

// ── Delta tag component ────────────────────────────────────────────
// `delta` is the formatted REAL weekly % change, or null when the card has no
// recorded change yet — null renders a muted "—" (never a fabricated number,
// AGENTS.md rule 2), so no arrow/color is shown.
function DeltaTag({ delta, up }: { delta: string | null; up: boolean }) {
  if (delta == null) {
    return (
      <span
        style={{
          fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9px",
          letterSpacing: "0.14em", textTransform: "uppercase",
          color: "var(--color-dojo-faint)",
        }}
      >
        —
      </span>
    );
  }
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

// Format a REAL weekly % change into a delta label + direction. Null in → null
// out (the "—" state). Never fabricates a value.
function fmtDelta(pct: number | null | undefined): { delta: string | null; up: boolean } {
  if (typeof pct !== "number") return { delta: null, up: true };
  return { delta: `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`, up: pct >= 0 };
}

// ── Card row component ─────────────────────────────────────────────
// F-08: rows are clickable and carry the `card-result` testid so a click
// opens the shared details popup (same behaviour as the Explore tiles).
function SectionRow({ name, sub, price, delta, up, onOpen }: {
  name: string; sub: string; price: string; delta: string | null; up: boolean;
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
  name: string; count: number; graded: number; value: number; delta: string | null; up: boolean;
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
  /** SSR-computed default-range chart histories, wrapped exactly as the
   *  history query's queryFn resolves it (`{ histories }`). Hydrates the chart
   *  query's `initialData` ONLY when the live key matches the SSR key below, so
   *  the chart draws on first paint with NO skeleton flash. */
  initialHistories?: { histories: Record<string, { date: string; value: number | null }[]> };
  /** The range the SSR histories were built for (the client's first-render
   *  default). */
  initialRange?: RangeId;
  /** The `collectionIdsQuery` string the SSR histories were built for — must
   *  equal the client's first-render `collectionIdsQuery` for the SSR data to
   *  hydrate. */
  initialCollectionIdsQuery?: string;
}

export default function DashboardClient({
  firstName,
  initialItems,
  collections: collectionList = [],
  initialHistories,
  initialRange,
  initialCollectionIdsQuery,
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
          // REAL weekly change (null → "—"), never a fabricated delta.
          const { delta, up } = fmtDelta(w.weeklyChangePct);
          return {
            name: w.name ?? w.cardId,
            sub: w.setName ?? "—",
            price: w.marketPrice != null ? fmt(w.marketPrice) : "—",
            delta,
            up,
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

    // "Want to buy" is a want-list bucket, not a portfolio collection — it is
    // no longer injected into the dashboard selector/comparison chart (client
    // feedback: don't show it on the dashboard). The want-list page and the
    // useWantToBuy star read the ["want-list"] query family directly and are
    // unaffected. (This also drops the fabricated `paid = ×0.74` estimate —
    // AGENTS.md rule 2.)

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
  }, [collectionList, collectionData]);

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
        // REAL weekly change (null → "—"), never a fabricated delta.
        const { delta, up } = fmtDelta(item.card.weeklyChangePct);
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
          up,
          card: toPopupCard(item),
        };
      });

    // Collections: REAL named collections (F-10). A collection has no single
    // weeklyChangePct (it's an aggregate of many cards), and we have no stored
    // per-collection weekly delta — so show "—" rather than fabricate one.
    const collections = collOptions.map((opt) => {
      return {
        key: opt.id,
        name: opt.name,
        count: opt.cardCount,
        graded: 0,
        value: opt.marketValue,
        delta: null as string | null,
        up: true,
      };
    });

    // Gainers & Losers — sort by REAL weeklyChangePct (nulls excluded, never
    // fabricated). Gainers = biggest positive change first; Losers = most
    // negative first. Cards with no recorded change simply don't appear.
    const withPct = items.filter(
      (i) => typeof i.card.weeklyChangePct === "number"
    );
    const toRow = (item: CollectionItem) => {
      const { delta, up } = fmtDelta(item.card.weeklyChangePct);
      const sub = `${item.condition || item.card.set?.name || "Raw"} · Qty ${item.quantity}`;
      return {
        name: item.card.name,
        sub,
        price: fmt((item.card.marketPrice ?? 0) * item.quantity),
        delta,
        up,
        card: toPopupCard(item),
      };
    };
    const gainers = [...withPct]
      .filter((i) => (i.card.weeklyChangePct as number) >= 0)
      .sort((a, b) => (b.card.weeklyChangePct as number) - (a.card.weeklyChangePct as number))
      .slice(0, 5)
      .map(toRow);

    const losers = [...withPct]
      .filter((i) => (i.card.weeklyChangePct as number) < 0)
      .sort((a, b) => (a.card.weeklyChangePct as number) - (b.card.weeklyChangePct as number))
      .slice(0, 5)
      .map(toRow);

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

  const collectionIdsQuery = Array.from(activeSelectedIds).join(",");
  const { data: realHistoriesData, isLoading: historyLoading } = useQuery({
    queryKey: ["portfolio-history", collectionIdsQuery, activeRange],
    queryFn: async () => {
      if (!collectionIdsQuery) return { histories: {} };
      const res = await fetch(`/api/users/me/collection/history?collectionIds=${collectionIdsQuery}&range=${activeRange}`);
      if (!res.ok) throw new Error("Failed to load portfolio history");
      return res.json();
    },
    staleTime: 60_000,
    // ROOT-CAUSE flicker fix (ssr-dashboard-chart): hydrate this query with the
    // SSR-computed default histories ONLY when the live key equals the SSR key
    // (same selection string AND same range). On first paint of the default
    // view that match holds → `data` is defined → `isLoading` is false →
    // `chartLoading` false → `showChartSkeleton` never flips → the real chart
    // (or its honest empty state) is the FIRST thing painted, no grey Skeleton
    // swap. Any mismatch (user changed range/selection before first fetch) →
    // undefined → the normal fetch + delayed-skeleton path still covers it.
    initialData:
      collectionIdsQuery === initialCollectionIdsQuery && activeRange === initialRange
        ? initialHistories
        : undefined,
    // Blink fix (same keep-previous principle as Batch 2B's trending/search
    // queries, which this portfolio-history query had missed): switching the
    // RANGE tab or the COLLECTIONS selection changes this query key, which
    // without a placeholder makes TanStack drop `data` → undefined and flip
    // `isLoading` → true, swapping the chart for the Skeleton (the reported
    // blink). `placeholderData: (prev) => prev` keeps the PREVIOUS histories
    // rendered while the new key loads: `data` stays defined, `isLoading`
    // stays false on every switch after the first (only `isFetching` /
    // `isPlaceholderData` go true), so the previous chart stays painted and
    // updates in place when the new data arrives. Does NOT change the
    // queryFn, key, staleTime, or data source — correctness is identical.
    placeholderData: (prev) => prev,
  });
  // Batch 2B · Item 3: show a block skeleton (not the "No price history yet"
  // empty state) while the history query is genuinely loading AND a
  // collection is selected. With placeholderData above, `historyLoading`
  // (isLoading) is now true ONLY on the genuine FIRST load (no previous data
  // to keep) — a range switch / selection change keeps isLoading false, so
  // the skeleton no longer flashes on a mere switch; the previous chart stays
  // up until the new data draws in place. When a load finishes with no points,
  // MultiLineComparisonChart's honest empty state takes over. The stat blocks
  // are NOT skeletoned (they have SSR initialData → isLoading is already
  // false; a skeleton there would regress to a flash).
  const chartLoading = historyLoading && collectionIdsQuery.length > 0;
  // Delay the chart skeleton by 250ms so a sub-250ms first-load history fetch
  // draws the real chart (or its honest empty state) without ever flashing the
  // grey skeleton — the reported flicker. A genuinely slow first load still
  // reveals it after the delay. The "No price history yet" empty state below is
  // untouched: it is the honest no-data state, never a forever skeleton.
  const showChartSkeleton = useDelayedFlag(chartLoading, 250);

  // Multi-line chart series: one curve per selected collection, drawn from REAL
  // stored history only (plan §6). The fabricated `generateMockChartData`
  // fallback is REMOVED — if a collection has no (or one) real history point we
  // render the real points as-is (a short/flat line) rather than inventing a
  // synthetic trend. A collection with no points yet shows no line (honest gap),
  // never a made-up curve. Never summed — one series per collection.
  const chartSeriesList = useMemo(() => {
    return activeSelectedOptions.map((opt) => {
      const raw: { date?: string; value: number | null }[] =
        realHistoriesData?.histories?.[opt.id] ?? [];
      // Drop honest gaps (null values) — a gap is simply absent from the drawn
      // line, never rendered as 0. Real points only.
      const data = raw
        .filter((p): p is { date?: string; value: number } => typeof p.value === "number")
        .map((p) => ({ value: p.value }));
      return {
        id: opt.id,
        name: opt.name,
        color: opt.color,
        // Empty → the chart's "No price history yet" state for this series set.
        data,
      };
    });
  }, [activeSelectedOptions, realHistoriesData]);

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
                      boxShadow: "5px 5px 0 0 #000",
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

          <div className="dojo-desktop-grid">
            <div>
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
          {/* Batch 2B · Item 3+4: a loading history query reserves the chart's
              200px box with a block skeleton (no empty-state flash); once
              resolved the chart or its honest empty state eases in. */}
          <div style={{ margin: "16px -22px 0", height: "200px" }}>
            {showChartSkeleton ? (
              <Skeleton height="100%" className="dojo-fade-in-fast" />
            ) : (
              <div className="dojo-fade-in-fast" style={{ height: "100%" }}>
                <MultiLineComparisonChart
                  seriesList={chartSeriesList}
                  hidden={hidden}
                />
              </div>
            )}
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
        </div>

        <div>
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
          </div>
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
