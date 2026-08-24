"use client";

/**
 * Screen 06 — Portfolio (/portfolio)
 *
 * Shows ONLY the authenticated user's real, added cards — fetched from
 * GET /api/users/me/collection. Previously this page rendered a fixed
 * 6-card mock array (INV_CARDS) regardless of what the signed-in user
 * actually owned, so every account saw the same fake Luffy/Zoro/
 * Charizard cards. That mock has been removed entirely.
 *
 * The reference prototype's multi-"collection" selector (Main / want
 * to buy / high value tracker) is NOT ported here — the current
 * schema has no collection-grouping concept on `UserCollection` (it's
 * a flat per-user list with an `isFoil` variant, nothing else), so
 * there is no real data to back separate named collections. Adding
 * that grouping is a schema-level feature, not a portfolio-page
 * rendering fix — flagged rather than faked.
 *
 * Search (client-side, over the real list) and grid/list view toggle
 * are kept since those are genuine, functional conveniences over
 * whatever the user actually has.
 */

import { useState, useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

// ── Real collection item shape — matches GET /api/users/me/collection ──
interface CollectionItem {
  id: string;
  cardId: string;
  quantity: number;
  isFoil: boolean;
  condition: string | null;
  purchasePrice: number | null;
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

function fmt(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// ── Icons ──────────────────────────────────────────────────────────
function BellIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 01-3.46 0" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
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

// ── Delta tag — only rendered when a real delta exists. There is no
// price-history pipeline yet (PricingHistory table is unpopulated), so
// per-card gain/loss is never fabricated — see dashboard/page.tsx and
// api/cards/trending/route.ts for the same rule applied consistently. ──
function GainLossTag({ item }: { item: CollectionItem }) {
  if (item.purchasePrice == null || item.card.marketPrice == null) return null;
  const diff = item.card.marketPrice - item.purchasePrice;
  const pct = item.purchasePrice > 0 ? (diff / item.purchasePrice) * 100 : 0;
  const up = diff >= 0;
  return (
    <span
      style={{
        fontFamily: "var(--font-display)",
        fontWeight: 700,
        fontSize: "9px",
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: up ? "#00A86B" : "var(--color-dojo-vermilion)",
      }}
    >
      {up ? "▲" : "▼"} {up ? "+" : ""}{pct.toFixed(1)}%
    </span>
  );
}

function detailHref(item: CollectionItem): string {
  const params = new URLSearchParams({
    name: item.card.name,
    ...(item.card.set?.name ? { set: item.card.set.name } : {}),
    ...(item.card.imageUrl ? { img: item.card.imageUrl } : {}),
    ...(item.card.marketPrice ? { price: String(item.card.marketPrice) } : {}),
  });
  return `/search/${item.cardId}?${params.toString()}`;
}

// ── Card tile — grid view ──────────────────────────────────────────
function CollectionCardGrid({ item }: { item: CollectionItem }) {
  const price = item.card.marketPrice;
  const initials = getInitials(item.card.name);
  return (
    <Link
      href={detailHref(item)}
      style={{
        position: "relative",
        background: "var(--color-dojo-card)",
        border: "1px solid var(--color-dojo-stroke)",
        padding: "11px",
        cursor: "pointer",
        textDecoration: "none",
        display: "block",
      }}
    >
      {item.card.imageUrl ? (
        <img
          src={item.card.imageUrl}
          alt={item.card.name}
          loading="lazy"
          style={{ width: "100%", aspectRatio: "660 / 921", objectFit: "cover", background: "var(--color-dojo-raised)" }}
        />
      ) : (
        <div style={{ width: "100%", aspectRatio: "660 / 921", background: "var(--color-dojo-raised)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "22px", color: "var(--color-dojo-gold)" }}>{initials}</span>
        </div>
      )}
      <div style={{ marginTop: "9px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12.5px", lineHeight: 1.3, minHeight: "32px", color: "var(--color-dojo-ink)" }}>
        {item.card.name}
      </div>
      <div style={{ marginTop: "4px", fontSize: "10.5px", color: "var(--color-dojo-body)" }}>
        {item.card.set?.name ?? "Unknown set"}{item.isFoil ? " · Foil" : ""}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", marginTop: "9px", gap: "8px" }}>
        <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13.5px", fontVariantNumeric: "tabular-nums", color: price != null ? "var(--color-dojo-ink)" : "var(--color-dojo-faint)" }}>
          {price != null ? fmt(price) : "—"}
        </span>
        <span style={{ marginLeft: "auto" }}>
          <GainLossTag item={item} />
        </span>
      </div>
      <div style={{ marginTop: "5px", fontSize: "11px", color: "var(--color-dojo-faint)" }}>
        Qty: {item.quantity}
      </div>
    </Link>
  );
}

// ── Card row — list view ───────────────────────────────────────────
function CollectionCardList({ item }: { item: CollectionItem }) {
  const price = item.card.marketPrice;
  const initials = getInitials(item.card.name);
  return (
    <Link
      href={detailHref(item)}
      style={{
        position: "relative",
        background: "var(--color-dojo-card)",
        border: "1px solid var(--color-dojo-stroke)",
        padding: "12px 13px",
        marginBottom: "10px",
        cursor: "pointer",
        display: "flex",
        gap: "12px",
        alignItems: "center",
        textDecoration: "none",
      }}
    >
      {item.card.imageUrl ? (
        <img
          src={item.card.imageUrl}
          alt={item.card.name}
          loading="lazy"
          style={{ width: "40px", height: "56px", flex: "none", objectFit: "cover", background: "var(--color-dojo-raised)" }}
        />
      ) : (
        <div style={{ width: "40px", height: "56px", flex: "none", background: "var(--color-dojo-raised)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "12px", color: "var(--color-dojo-gold)" }}>{initials}</span>
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "12px" }}>
          <div style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13.5px", color: "var(--color-dojo-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {item.card.name}
          </div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "14px", fontVariantNumeric: "tabular-nums", color: price != null ? "var(--color-dojo-ink)" : "var(--color-dojo-faint)" }}>
            {price != null ? fmt(price) : "—"}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: "12px", marginTop: "6px" }}>
          <div style={{ flex: 1, fontSize: "11px", color: "var(--color-dojo-body)" }}>
            {item.card.set?.name ?? "Unknown set"}{item.isFoil ? " · Foil" : ""}
          </div>
          <GainLossTag item={item} />
        </div>
        <div style={{ marginTop: "6px", fontSize: "11px", color: "var(--color-dojo-faint)" }}>Qty: {item.quantity}</div>
      </div>
    </Link>
  );
}

export default function PortfolioPage() {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");

  const { data, isLoading, isError } = useQuery<CollectionApiResponse>({
    queryKey: ["portfolio-collection"],
    queryFn: async () => {
      const res = await fetch("/api/users/me/collection");
      if (!res.ok) throw new Error("Failed to load collection");
      return res.json();
    },
  });

  const items = data?.items ?? [];

  const collTotal = useMemo(
    () => items.reduce((a, i) => a + (i.card.marketPrice ?? 0) * i.quantity, 0),
    [items]
  );

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((i) => i.card.name.toLowerCase().includes(q)) : items;
  }, [items, query]);

  return (
    <div style={{ padding: "6px 22px 24px" }}>
      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "center", margin: "16px 0 14px" }}>
        <h1 className="dojo-heading" style={{ fontSize: "24px", margin: 0 }}>portfolio</h1>
        <span style={{ marginLeft: "auto", color: "var(--color-dojo-body)", display: "flex" }}>
          <BellIcon />
        </span>
      </div>

      {/* ── Search bar ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          border: "1px solid var(--color-dojo-stroke)",
          background: "var(--color-dojo-card)",
          padding: "12px 13px",
          color: "var(--color-dojo-ink)",
        }}
      >
        <span style={{ display: "flex", color: "var(--color-dojo-body)" }}><SearchIcon /></span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search my portfolio"
          style={{
            flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none",
            fontSize: "13.5px", color: "var(--color-dojo-ink)",
          }}
        />
      </div>

      {/* ── Total value ── */}
      <div style={{ marginTop: "20px" }}>
        <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontStretch: "112%", fontSize: "10px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
          Total value
        </span>
        <div style={{ marginTop: "6px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "32px", lineHeight: 1.05, fontVariantNumeric: "tabular-nums", color: "var(--color-dojo-ink)" }}>
          {isLoading ? "—" : fmt(collTotal)}
        </div>
      </div>

      {/* ── Item count + view toggle ── */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", margin: "22px 0 12px" }}>
        <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
          My cards
        </span>
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
          {filteredItems.length} item{filteredItems.length !== 1 ? "s" : ""}
        </span>
        <div style={{ display: "flex" }}>
          <button
            onClick={() => setView("list")}
            aria-label="List view"
            style={{
              width: "32px", height: "32px", display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", border: "none", padding: 0,
              background: view === "list" ? "var(--color-dojo-gold)" : "transparent",
              color: view === "list" ? "#0D0D0D" : "var(--color-dojo-faint)",
              boxShadow: view === "list" ? "none" : "inset 0 0 0 1px var(--color-dojo-stroke)",
            }}
          >
            <ListIcon />
          </button>
          <button
            onClick={() => setView("grid")}
            aria-label="Grid view"
            style={{
              width: "32px", height: "32px", display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", border: "none", padding: 0,
              background: view === "grid" ? "var(--color-dojo-gold)" : "transparent",
              color: view === "grid" ? "#0D0D0D" : "var(--color-dojo-faint)",
              boxShadow: view === "grid" ? "none" : "inset 0 0 0 1px var(--color-dojo-stroke)",
            }}
          >
            <GridIcon />
          </button>
        </div>
      </div>

      {/* ── Card list/grid ── */}
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
            {items.length === 0
              ? "add a card from search or the scanner to start your portfolio."
              : "no cards match this search."}
          </p>
          {items.length === 0 && (
            <Link href="/search" className="dojo-btn dojo-btn-primary" style={{ textDecoration: "none", display: "inline-flex", width: "auto", padding: "12px 22px" }}>
              SEARCH CARDS
            </Link>
          )}
        </div>
      ) : view === "grid" ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
          {filteredItems.map((item) => <CollectionCardGrid key={item.id} item={item} />)}
        </div>
      ) : (
        <div>
          {filteredItems.map((item) => <CollectionCardList key={item.id} item={item} />)}
        </div>
      )}
    </div>
  );
}
