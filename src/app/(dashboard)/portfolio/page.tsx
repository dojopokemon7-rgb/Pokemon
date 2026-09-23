"use client";

/**
 * Screen 06 — Portfolio (/portfolio)
 *
 * Shows the authenticated user's real, added cards (GET
 * /api/users/me/collection). Overhauled to match the prototype:
 *   - Search bar ("search my portfolio") + filter icon.
 *   - TOTAL VALUE headline with two filters: a status filter ("All cards"
 *     / Graded / Raw / Foil) and a multi-select Collections filter.
 *   - Grid/list of card tiles (2-col mobile) with a Select mode for bulk
 *     delete behind a double confirmation.
 *
 * Removed vs the previous version (per design): the Main/Want List/High
 * Value group chips, the My cards/Favorites/Sold sub-tabs, and the
 * Favorites concept entirely. Favorites has been removed app-wide and
 * replaced by "Want to Buy" (see /wantlist + the star on search tiles).
 */

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { CardImage, cardInitials } from "@/components/CardImage";
import { Toast } from "@/components/Toast";

// ── Real collection item shape — matches GET /api/users/me/collection ──
interface CollectionItem {
  id: string;
  cardId: string;
  quantity: number;
  isFoil: boolean;
  condition: string | null;
  purchasePrice: number | null;
  collectionId?: string | null;
  addedAt: string;
  card: {
    id: string;
    name: string;
    number: string;
    rarity: string | null;
    imageUrl: string | null;
    marketPrice: number | null;
    set: { name: string } | null;
  };
}

interface CollectionApiResponse {
  items: CollectionItem[];
}

interface CollectionMeta {
  id: string;
  name: string;
}

function fmt(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

// ── Icons ──────────────────────────────────────────────────────────
function SearchIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}
function FilterIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  );
}
function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <rect width="6" height="6" fill="currentColor" />
      <rect x="8" width="6" height="6" fill="currentColor" />
      <rect y="8" width="6" height="6" fill="currentColor" />
      <rect x="8" y="8" width="6" height="6" fill="currentColor" />
    </svg>
  );
}
function ListIcon() {
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
      <rect width="14" height="2" fill="currentColor" />
      <rect y="5" width="14" height="2" fill="currentColor" />
      <rect y="10" width="14" height="2" fill="currentColor" />
    </svg>
  );
}

// ── Delta tag — only when a real gain/loss exists (no price-history
// pipeline yet, so per-card % is never fabricated). ──
function GainLossTag({ item }: { item: CollectionItem }) {
  if (item.purchasePrice == null || item.card.marketPrice == null) return null;
  const diff = item.card.marketPrice - item.purchasePrice;
  const pct = item.purchasePrice > 0 ? (diff / item.purchasePrice) * 100 : 0;
  const up = diff >= 0;
  return (
    <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9px", letterSpacing: "0.14em", textTransform: "uppercase", color: up ? "var(--color-dojo-jade)" : "var(--color-dojo-vermilion)" }}>
      {up ? "▲" : "▼"} {up ? "+" : ""}{pct.toFixed(1)}%
    </span>
  );
}

// A card is "graded" if its free-text condition names a grading company.
const GRADED_RE = /\b(psa|bgs|cgc|sgc|beckett)\b/i;
const isGraded = (c: string | null) => !!c && GRADED_RE.test(c);

/** Sub-line like "Obsidian Flames · PSA 10" / "Base Set · Raw · Foil". */
function subLine(item: CollectionItem): string {
  const parts: string[] = [];
  const setName = item.card.set?.name;
  if (setName && setName.toLowerCase() !== "unknown set") parts.push(setName);
  parts.push(isGraded(item.condition) ? (item.condition as string) : "Raw");
  if (item.isFoil) parts.push("Foil");
  return parts.join(" · ");
}

function detailHref(item: CollectionItem): string {
  // Infer game from the card's externalId prefix (One Piece Bandai codes
  // vs everything else = Pokémon) so the detail page shows the right
  // franchise + serial even though the portfolio has no explicit game field.
  const game = /^(OP|ST|EB|PRB)\d{2}-\d{3}$/i.test(item.cardId) ? "onepiece" : "pokemon";
  const params = new URLSearchParams({
    name: item.card.name,
    game,
    ...(item.card.set?.name ? { set: item.card.set.name } : {}),
    ...(item.card.imageUrl ? { img: item.card.imageUrl } : {}),
    ...(item.card.marketPrice ? { price: String(item.card.marketPrice) } : {}),
    ...(item.card.number ? { number: item.card.number } : {}),
    ...(item.card.rarity ? { rarity: item.card.rarity } : {}),
  });
  return `/search/${item.cardId}?${params.toString()}`;
}

// ── Selection checkbox overlay (shown in Select mode) ──
function SelectCheckbox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        position: "absolute", top: "8px", left: "8px", zIndex: 2,
        width: "24px", height: "24px",
        border: "1px solid " + (checked ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"),
        background: checked ? "var(--color-dojo-gold)" : "rgba(13,13,13,0.7)",
        color: "var(--color-dojo-app)", display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: "14px", fontWeight: 900, lineHeight: 1,
      }}
    >
      {checked ? "✓" : ""}
    </span>
  );
}

// Small "Want to Sell" pill overlaid on an owned-card tile. Stops the click
// from bubbling to the tile's navigation Link.
function WantToSellButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
      style={{
        marginTop: "8px", width: "100%", padding: "8px 0", cursor: "pointer",
        border: "1px solid var(--color-dojo-stroke)", background: "transparent",
        color: "var(--color-dojo-faint)", fontFamily: "var(--font-display)", fontWeight: 800,
        fontSize: "9px", letterSpacing: "0.14em", textTransform: "uppercase",
      }}
    >
      Want to Sell
    </button>
  );
}

// ── Card tile — grid view ──────────────────────────────────────────
function CardGrid({
  item, selectMode, selected, onToggleSelect, onWantToSell, owned,
}: {
  item: CollectionItem;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onWantToSell: (item: CollectionItem) => void;
  owned: boolean;
}) {
  const price = item.card.marketPrice;
  const inner = (
    <>
      {selectMode && <SelectCheckbox checked={selected} />}
      <CardImage src={item.card.imageUrl} alt={item.card.name} initials={cardInitials(item.card.name)} style={{ background: "var(--color-dojo-raised)", border: "none" }} />
      <div style={{ marginTop: "9px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12.5px", lineHeight: 1.3, minHeight: "32px", color: "var(--color-dojo-ink)" }}>
        {item.card.name}
      </div>
      <div style={{ marginTop: "4px", fontSize: "10.5px", color: "var(--color-dojo-body)" }}>{subLine(item)}</div>
      <div style={{ display: "flex", alignItems: "baseline", marginTop: "9px", gap: "8px" }}>
        <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13.5px", fontVariantNumeric: "tabular-nums", color: price != null ? "var(--color-dojo-ink)" : "var(--color-dojo-faint)" }}>
          {price != null ? fmt(price) : "—"}
        </span>
        <span style={{ marginLeft: "auto" }}><GainLossTag item={item} /></span>
      </div>
      <div style={{ marginTop: "5px", fontSize: "11px", color: "var(--color-dojo-faint)" }}>Qty: {item.quantity}</div>
    </>
  );
  const box: React.CSSProperties = {
    position: "relative", background: "var(--color-dojo-card)",
    border: "1px solid " + (selected ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"),
    padding: "11px", textDecoration: "none", display: "block", cursor: "pointer",
  };
  // In select mode the whole tile toggles selection instead of navigating.
  if (selectMode) {
    return (
      <div className="dojo-card-tile" style={box} role="button" tabIndex={0}
        onClick={() => onToggleSelect(item.id)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleSelect(item.id); } }}
        aria-pressed={selected}
      >
        {inner}
      </div>
    );
  }
  // The Want to Sell pill is a sibling of the Link (a <button> can't live
  // inside an <a>), sharing the tile's bordered box.
  return (
    <div style={box}>
      <Link href={detailHref(item)} className="dojo-card-tile" style={{ textDecoration: "none", display: "block" }}>{inner}</Link>
      {owned && <WantToSellButton onClick={() => onWantToSell(item)} />}
    </div>
  );
}

// ── Card row — list view ───────────────────────────────────────────
function CardRow({
  item, selectMode, selected, onToggleSelect, onWantToSell, owned,
}: {
  item: CollectionItem;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onWantToSell: (item: CollectionItem) => void;
  owned: boolean;
}) {
  const price = item.card.marketPrice;
  const inner = (
    <>
      {selectMode && (
        <span aria-hidden="true" style={{ flex: "none", width: "22px", height: "22px", border: "1px solid " + (selected ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"), background: selected ? "var(--color-dojo-gold)" : "transparent", color: "var(--color-dojo-app)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "13px", fontWeight: 900 }}>
          {selected ? "✓" : ""}
        </span>
      )}
      <div style={{ width: "40px", flex: "none" }}>
        <CardImage src={item.card.imageUrl} alt={item.card.name} initials={cardInitials(item.card.name)} aspectRatio="660 / 921" initialsSize="12px" style={{ background: "var(--color-dojo-raised)", border: "none" }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "12px" }}>
          <div style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13.5px", color: "var(--color-dojo-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {item.card.name}
          </div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "14px", fontVariantNumeric: "tabular-nums", color: price != null ? "var(--color-dojo-ink)" : "var(--color-dojo-faint)" }}>
            {price != null ? fmt(price) : "—"}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "6px" }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: "11px", color: "var(--color-dojo-body)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{subLine(item)}</div>
          <GainLossTag item={item} />
        </div>
        <div style={{ marginTop: "6px", fontSize: "11px", color: "var(--color-dojo-faint)" }}>Qty: {item.quantity}</div>
      </div>
    </>
  );
  const box: React.CSSProperties = {
    position: "relative", background: "var(--color-dojo-card)",
    border: "1px solid " + (selected ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"),
    padding: "12px 13px", marginBottom: "10px", display: "flex", gap: "12px", alignItems: "center", textDecoration: "none",
  };
  if (selectMode) {
    return (
      <div className="dojo-card-tile" style={box} role="button" tabIndex={0}
        onClick={() => onToggleSelect(item.id)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleSelect(item.id); } }}
        aria-pressed={selected}
      >
        {inner}
      </div>
    );
  }
  // Row: the navigation Link fills the row; a compact Want to Sell pill sits
  // at the right as a sibling (a <button> can't live inside the <a>).
  return (
    <div style={box}>
      <Link href={detailHref(item)} className="dojo-card-tile" style={{ flex: 1, minWidth: 0, display: "flex", gap: "12px", alignItems: "center", textDecoration: "none" }}>{inner}</Link>
      {owned && (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onWantToSell(item); }}
          aria-label="Want to Sell"
          style={{
            flex: "none", padding: "8px 12px", cursor: "pointer", whiteSpace: "nowrap",
            border: "1px solid var(--color-dojo-stroke)", background: "transparent",
            color: "var(--color-dojo-faint)", fontFamily: "var(--font-display)", fontWeight: 800,
            fontSize: "9px", letterSpacing: "0.14em", textTransform: "uppercase",
          }}
        >
          Want to Sell
        </button>
      )}
    </div>
  );
}

const dropdownBtn: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: "6px", padding: "6px 10px", cursor: "pointer",
  border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)", color: "var(--color-dojo-ink)",
  fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "9.5px", letterSpacing: "0.12em", textTransform: "uppercase", whiteSpace: "nowrap",
};
// Gold accent when a filter pill has a non-default value active.
const activePill: React.CSSProperties = {
  border: "1px solid var(--color-dojo-gold)",
  background: "var(--color-dojo-gold)",
  color: "var(--color-dojo-app)",
};

// Dropdown 1 — card type / intent filter.
type CardType = "all" | "want-to-buy" | "high-value";
const CARD_TYPE_OPTIONS: { id: CardType; label: string }[] = [
  { id: "all", label: "All cards" },
  { id: "want-to-buy", label: "Want to buy" },
  { id: "high-value", label: "High value card tracker" },
];
// A card counts as "high value" at or above this market price (owned cards).
const HIGH_VALUE_THRESHOLD = 100;

export default function PortfolioPage() {
  const [query, setQuery] = useState("");
  // Default to list on mobile, grid on desktop (Task 3). Resolved once on
  // mount from the viewport; the user can still toggle freely after.
  const [view, setView] = useState<"grid" | "list">("list");
  // Dropdown 1: card type/intent. Dropdown 2: collection ("all" | id |
  // "__uncat__"). They compose with AND logic for owned cards.
  const [cardType, setCardType] = useState<CardType>("all");
  const [typeOpen, setTypeOpen] = useState(false);
  const [selectedColl, setSelectedColl] = useState<string>("all");
  const [collOpen, setCollOpen] = useState(false);
  // Select / bulk-delete mode.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Owned cards can be listed as WANT TO SELL — writes the same want-list
  // API with intent SELL, so they surface under the /wantlist "Want to Sell"
  // tab (never the Buy tab).
  const wantToSell = useMutation({
    mutationFn: async (cardId: string) => {
      const res = await fetch("/api/want-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ cardId, intent: "SELL" }),
      });
      if (!res.ok) throw new Error("Could not add to Want to Sell.");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["want-list"] });
      setToast("Added to Want to Sell");
    },
    onError: (err: Error) => setToast(err.message),
  });

  // Responsive default view: grid on desktop (≥640px), list on mobile.
  // Runs once on mount; honors the user's manual toggle afterward.
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia("(min-width: 640px)").matches) {
      setView("grid");
    }
  }, []);

  const { data, isLoading, isError } = useQuery<CollectionApiResponse>({
    queryKey: ["portfolio-collection"],
    queryFn: async () => {
      const res = await fetch("/api/users/me/collection");
      if (!res.ok) throw new Error("Failed to load collection");
      return res.json();
    },
  });

  // Named collections for the Collections filter.
  const { data: collMeta } = useQuery<CollectionMeta[]>({
    queryKey: ["collections"],
    queryFn: async () => {
      const res = await fetch("/api/collections", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load collections");
      const json = await res.json();
      return json.data as CollectionMeta[];
    },
  });

  // Want to Buy list — a different data source (not owned cards). Only
  // fetched/used when the "Want to buy" card-type filter is active. The
  // rows are normalized into the owned-card tile shape below.
  const { data: wantData } = useQuery<{ data: { id: string; cardId: string; name: string | null; imageUrl: string | null; marketPrice: number | null; setName: string | null }[] }>({
    queryKey: ["want-list", "BUY"],
    queryFn: async () => {
      const res = await fetch("/api/want-list?intent=BUY", { credentials: "include" });
      if (!res.ok) return { data: [] };
      return res.json();
    },
    enabled: cardType === "want-to-buy",
  });

  // Bulk delete — DELETE is per-id, so fan out over the selection.
  const bulkDelete = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => fetch(`/api/users/me/collection/${id}`, { method: "DELETE" }))
      );
      const failed = results.filter((r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok));
      if (failed.length) throw new Error(`${failed.length} of ${ids.length} deletes failed`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["portfolio-collection"] });
      queryClient.invalidateQueries({ queryKey: ["collection"] });
      setSelectedIds(new Set());
      setSelectMode(false);
      setConfirmOpen(false);
    },
  });

  const items = data?.items ?? [];

  // Dropdown 2 (Collections) options: "All collections" (default), the
  // user's real named collections, then "Uncategorized" for loose cards.
  const collOptions = useMemo(() => {
    const opts = [{ id: "all", name: "All collections" }];
    for (const c of collMeta ?? []) opts.push({ id: c.id, name: c.name });
    opts.push({ id: "__uncat__", name: "Uncategorized" });
    return opts;
  }, [collMeta]);

  // Want-list rows normalized into the owned-card tile shape so the grid
  // can render them uniformly. They have no owned metadata (quantity 1, no
  // collection/condition/purchase price), so gain/loss never shows.
  const wantAsItems: CollectionItem[] = useMemo(
    () =>
      (wantData?.data ?? []).map((w) => ({
        id: `want-${w.id}`,
        cardId: w.cardId,
        quantity: 1,
        isFoil: false,
        condition: null,
        purchasePrice: null,
        collectionId: null,
        addedAt: "",
        card: {
          id: w.cardId,
          name: w.name ?? w.cardId,
          number: "",
          rarity: null,
          imageUrl: w.imageUrl,
          marketPrice: w.marketPrice,
          set: w.setName ? { name: w.setName } : null,
        },
      })),
    [wantData]
  );

  // Compose the two dropdowns (AND logic) + search:
  //   - "want to buy" swaps the source to the want-list (collections filter
  //     doesn't apply — those items aren't filed in collections).
  //   - "high value" keeps owned cards at/above the value threshold.
  //   - collections filter narrows owned cards to one collection.
  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    const source = cardType === "want-to-buy" ? wantAsItems : items;
    return source.filter((i) => {
      if (q && !i.card.name.toLowerCase().includes(q)) return false;
      if (cardType === "high-value" && (i.card.marketPrice ?? 0) < HIGH_VALUE_THRESHOLD) return false;
      // Collections filter only applies to owned cards (not want-to-buy).
      if (cardType !== "want-to-buy" && selectedColl !== "all" && (i.collectionId ?? "__uncat__") !== selectedColl) return false;
      return true;
    });
  }, [items, wantAsItems, query, cardType, selectedColl]);

  // Total value reflects the current filters (what the user is looking at).
  const totalValue = useMemo(
    () => filteredItems.reduce((a, i) => a + (i.card.marketPrice ?? 0) * i.quantity, 0),
    [filteredItems]
  );

  const typeLabel = CARD_TYPE_OPTIONS.find((o) => o.id === cardType)!.label;
  const collLabel = collOptions.find((o) => o.id === selectedColl)?.name ?? "All collections";
  // Want-to-buy items aren't owned rows, so bulk-delete doesn't apply.
  const canSelect = cardType !== "want-to-buy";

  const toggleSelectId = (id: string) =>
    setSelectedIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div style={{ padding: "6px 22px 24px" }}>
      {/* ── Search bar + filter icon ── */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "16px" }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: "10px", border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)", padding: "12px 13px", color: "var(--color-dojo-ink)" }}>
          <span style={{ display: "flex", color: "var(--color-dojo-body)" }}><SearchIcon /></span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search my portfolio"
            aria-label="Search my portfolio"
            style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", fontSize: "13.5px", color: "var(--color-dojo-ink)" }}
          />
        </div>
        <button
          type="button"
          aria-label="Filters"
          title="Filters"
          onClick={() => setTypeOpen((v) => !v)}
          style={{ flex: "none", width: "44px", height: "44px", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)", color: "var(--color-dojo-body)" }}
        >
          <FilterIcon />
        </button>
      </div>

      {/* ── Total value + two filter dropdowns ── */}
      <div style={{ marginTop: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontStretch: "112%", fontSize: "10px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
            Total value
          </span>

          {/* Dropdown 1 — card type/intent (All cards / Want to buy / High
              value). Gold pill when a non-default is active. */}
          <div style={{ position: "relative" }}>
            <button type="button" data-testid="card-type-filter" aria-haspopup="listbox" aria-expanded={typeOpen}
              onClick={() => { setTypeOpen((v) => !v); setCollOpen(false); }}
              style={{ ...dropdownBtn, ...(cardType !== "all" ? activePill : null) }}
            >
              {typeLabel}<span aria-hidden="true" style={{ fontSize: "8px", opacity: 0.7 }}>▾</span>
            </button>
            {typeOpen && (
              <>
                <div onClick={() => setTypeOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
                <div role="listbox" aria-label="Filter by card type" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 61, minWidth: "210px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", boxShadow: "0 10px 30px rgba(0,0,0,0.5)" }}>
                  {CARD_TYPE_OPTIONS.map((o) => {
                    const on = cardType === o.id;
                    return (
                      <button key={o.id} type="button" role="option" aria-selected={on}
                        onClick={() => { setCardType(o.id); setTypeOpen(false); setSelectMode(false); setSelectedIds(new Set()); }}
                        style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 14px", cursor: "pointer", background: on ? "rgba(233,180,59,0.08)" : "none", border: "none", borderBottom: "1px solid var(--color-dojo-divider)", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12px", color: on ? "var(--color-dojo-gold)" : "var(--color-dojo-ink)" }}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* Dropdown 2 — Collections (All collections / named / Uncategorized).
              Disabled while "Want to buy" is active (those aren't filed in
              collections). Gold pill when a non-default is active. */}
          <div style={{ position: "relative" }}>
            <button type="button" data-testid="collection-filter" aria-haspopup="listbox" aria-expanded={collOpen}
              disabled={cardType === "want-to-buy"}
              onClick={() => { setCollOpen((v) => !v); setTypeOpen(false); }}
              style={{ ...dropdownBtn, ...(selectedColl !== "all" ? activePill : null), ...(cardType === "want-to-buy" ? { opacity: 0.4, cursor: "not-allowed" } : null) }}
            >
              {collLabel}<span aria-hidden="true" style={{ fontSize: "8px", opacity: 0.7 }}>▾</span>
            </button>
            {collOpen && cardType !== "want-to-buy" && (
              <>
                <div onClick={() => setCollOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
                <div role="listbox" aria-label="Filter by collection" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 61, minWidth: "200px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", boxShadow: "0 10px 30px rgba(0,0,0,0.5)" }}>
                  {collOptions.map((o) => {
                    const on = selectedColl === o.id;
                    return (
                      <button key={o.id} type="button" role="option" aria-selected={on}
                        onClick={() => { setSelectedColl(o.id); setCollOpen(false); }}
                        style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 14px", cursor: "pointer", background: on ? "rgba(233,180,59,0.08)" : "none", border: "none", borderBottom: "1px solid var(--color-dojo-divider)", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12px", color: on ? "var(--color-dojo-gold)" : "var(--color-dojo-ink)" }}
                      >
                        {o.name}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>

        <div style={{ marginTop: "6px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "32px", lineHeight: 1.05, fontVariantNumeric: "tabular-nums", color: "var(--color-dojo-ink)" }}>
          {isLoading ? "—" : fmt(totalValue)}
        </div>
      </div>

      {/* ── List header: current view name · item count · Select · view toggle ── */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", margin: "20px 0 12px" }}>
        <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
          {typeLabel}
        </span>
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
          {filteredItems.length} item{filteredItems.length !== 1 ? "s" : ""}
        </span>

        {/* Select mode toggle — only for owned cards (want-to-buy items
            can't be bulk-deleted from here). */}
        {canSelect && (
          <button
            type="button"
            onClick={() => { setSelectMode((v) => !v); setSelectedIds(new Set()); }}
            style={{ ...dropdownBtn, background: selectMode ? "var(--color-dojo-gold)" : "var(--color-dojo-card)", color: selectMode ? "var(--color-dojo-app)" : "var(--color-dojo-ink)", border: "1px solid " + (selectMode ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)") }}
          >
            {selectMode ? "Cancel" : "Select"}
          </button>
        )}

        <div style={{ display: "flex" }}>
          <button onClick={() => setView("list")} aria-label="List view"
            style={{ width: "32px", height: "32px", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", border: "none", padding: 0, background: view === "list" ? "var(--color-dojo-gold)" : "transparent", color: view === "list" ? "var(--color-dojo-app)" : "var(--color-dojo-faint)", boxShadow: view === "list" ? "none" : "inset 0 0 0 1px var(--color-dojo-stroke)" }}>
            <ListIcon />
          </button>
          <button onClick={() => setView("grid")} aria-label="Grid view"
            style={{ width: "32px", height: "32px", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", border: "none", padding: 0, background: view === "grid" ? "var(--color-dojo-gold)" : "transparent", color: view === "grid" ? "var(--color-dojo-app)" : "var(--color-dojo-faint)", boxShadow: view === "grid" ? "none" : "inset 0 0 0 1px var(--color-dojo-stroke)" }}>
            <GridIcon />
          </button>
        </div>
      </div>

      {/* ── Bulk delete bar (select mode, ≥1 selected) ── */}
      {selectMode && selectedIds.size > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px", padding: "10px 13px", border: "1px solid var(--color-dojo-gold)", background: "rgba(233,180,59,0.08)" }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "11px", color: "var(--color-dojo-ink)" }}>
            {selectedIds.size} selected
          </span>
          <button type="button" onClick={() => setConfirmOpen(true)}
            style={{ marginLeft: "auto", padding: "8px 16px", cursor: "pointer", border: "1px solid var(--color-dojo-vermilion)", background: "var(--color-dojo-vermilion)", color: "#fff", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase" }}>
            Delete Selected
          </button>
        </div>
      )}

      {/* ── Content ── */}
      {isLoading ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} style={{ background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "11px" }}>
              <div style={{ width: "100%", aspectRatio: "660 / 921", background: "var(--color-dojo-raised)", animation: "dojo-pulse 1.5s ease-in-out infinite" }} />
            </div>
          ))}
        </div>
      ) : isError ? (
        <div style={{ border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)", padding: "30px 22px", textAlign: "center" }}>
          <p className="dojo-heading" style={{ fontSize: "20px", margin: 0 }}>couldn&apos;t load your portfolio</p>
          <p className="dojo-body" style={{ marginTop: "8px", marginBottom: 0 }}>check your connection and try again.</p>
        </div>
      ) : filteredItems.length === 0 ? (
        <div style={{ border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)", padding: "30px 22px", textAlign: "center" }}>
          <p className="dojo-heading" style={{ fontSize: "20px", margin: 0 }}>
            {items.length === 0 ? "nothing here yet" : "no matches"}
          </p>
          <p className="dojo-body" style={{ marginTop: "8px", marginBottom: items.length === 0 ? "18px" : 0 }}>
            {items.length === 0 ? "add a card from search or the scanner to start your portfolio." : "no cards match these filters."}
          </p>
          {items.length === 0 && (
            <Link href="/search" className="dojo-btn dojo-btn-primary" style={{ textDecoration: "none", display: "inline-flex", width: "auto", padding: "12px 22px" }}>
              SEARCH CARDS
            </Link>
          )}
        </div>
      ) : view === "grid" ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          {filteredItems.map((item) => (
            <CardGrid key={item.id} item={item} selectMode={selectMode} selected={selectedIds.has(item.id)} onToggleSelect={toggleSelectId} onWantToSell={(i) => wantToSell.mutate(i.cardId)} owned={canSelect} />
          ))}
        </div>
      ) : (
        <div>
          {filteredItems.map((item) => (
            <CardRow key={item.id} item={item} selectMode={selectMode} selected={selectedIds.has(item.id)} onToggleSelect={toggleSelectId} onWantToSell={(i) => wantToSell.mutate(i.cardId)} owned={canSelect} />
          ))}
        </div>
      )}

      {/* ── Double-confirm delete modal ── */}
      {confirmOpen && (
        <>
          <div onClick={() => !bulkDelete.isPending && setConfirmOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(0,0,0,0.6)" }} />
          <div role="dialog" aria-modal="true" aria-label="Confirm delete" style={{ position: "fixed", inset: 0, zIndex: 91, display: "flex", alignItems: "center", justifyContent: "center", padding: "22px", pointerEvents: "none" }}>
            <div style={{ pointerEvents: "auto", width: "100%", maxWidth: "340px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "20px" }}>
              <h2 className="dojo-heading" style={{ fontSize: "18px", margin: "0 0 10px" }}>Delete cards?</h2>
              <p className="dojo-body" style={{ margin: "0 0 18px", fontSize: "13px", lineHeight: 1.5 }}>
                Are you sure you want to delete {selectedIds.size} card{selectedIds.size !== 1 ? "s" : ""}? This cannot be undone.
              </p>
              {bulkDelete.isError && (
                <p style={{ margin: "0 0 12px", fontSize: "12px", color: "var(--color-dojo-vermilion)" }}>Some deletes failed. Please try again.</p>
              )}
              <div style={{ display: "flex", gap: "10px" }}>
                <button type="button" disabled={bulkDelete.isPending} onClick={() => setConfirmOpen(false)}
                  className="dojo-btn dojo-btn-outline" style={{ flex: 1, width: "auto", height: "44px" }}>
                  Cancel
                </button>
                <button type="button" disabled={bulkDelete.isPending} onClick={() => bulkDelete.mutate([...selectedIds])}
                  style={{ flex: 1, height: "44px", cursor: "pointer", border: "1px solid var(--color-dojo-vermilion)", background: "var(--color-dojo-vermilion)", color: "#fff", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px", letterSpacing: "0.14em", textTransform: "uppercase" }}>
                  {bulkDelete.isPending ? "Deleting…" : "Yes, Delete"}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Want-to-sell confirmation / error toast. */}
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}
