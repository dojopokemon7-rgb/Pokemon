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
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { CardImage, cardInitials } from "@/components/CardImage";
import { WantList } from "@/components/WantList";

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

// Initials fallback now provided by the shared @/components/CardImage
// module (cardInitials). Portfolio tiles pass name through that helper.

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
        color: up ? "var(--color-dojo-jade)" : "var(--color-dojo-vermilion)",
      }}
    >
      {up ? "▲" : "▼"} {up ? "+" : ""}{pct.toFixed(1)}%
    </span>
  );
}

// ── Graded / ungraded badge (Defect 2) ────────────────────────────
// A card is considered "graded" if its free-text `condition` names a
// grading company (PSA/BGS/CGC/SGC/Beckett) — the same heuristic the
// /you stat grid uses to count graded cards. Graded → gold badge
// showing the condition text (e.g. "PSA 10"); ungraded → grey "Raw".
// ponytail: heuristic on free-text condition — upgrade path is a
// dedicated grader/grade column on UserCollection.
const GRADED_RE = /\b(psa|bgs|cgc|sgc|beckett)\b/i;

function GradeBadge({ condition }: { condition: string | null }) {
  const graded = !!condition && GRADED_RE.test(condition);
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 6px",
        fontFamily: "var(--font-display)",
        fontWeight: 700,
        fontSize: "8.5px",
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        border: "1px solid " + (graded ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"),
        color: graded ? "var(--color-dojo-gold)" : "var(--color-dojo-faint)",
        background: graded ? "rgba(233,180,59,0.10)" : "transparent",
        whiteSpace: "nowrap",
      }}
    >
      {graded ? (condition as string) : "Raw"}
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

// ── Favorite card tile — grid view (Favorites tab) ─────────────────
// A lighter tile than the collection card: favorites have no quantity,
// foil, or gain/loss — just the card + a filled gold star to unstar.
// Links to the detail page keyed by externalId so the detail-page star
// stays in sync with this list.
function FavoriteCardGrid({
  fav,
  isRemoving,
  onRemove,
}: {
  fav: FavoriteRow;
  isRemoving: boolean;
  onRemove: () => void;
}) {
  const c = fav.card;
  const initials = cardInitials(c.name);
  const setName = c.set?.name;
  const showSet = setName && setName.toLowerCase() !== "unknown set";
  const detail = (() => {
    const params = new URLSearchParams({ name: c.name });
    if (showSet && setName) params.set("set", setName);
    if (c.imageUrl) params.set("img", c.imageUrl);
    if (c.marketPrice != null) params.set("price", String(c.marketPrice));
    return `/search/${c.externalId}?${params.toString()}`;
  })();
  return (
    <Link
      href={detail}
      className="dojo-card-tile"
      style={{
        position: "relative",
        background: "var(--color-dojo-card)",
        border: "1px solid var(--color-dojo-stroke)",
        padding: "11px",
        textDecoration: "none",
        display: "block",
      }}
    >
      <CardImage
        src={c.imageUrl}
        alt={c.name}
        initials={initials}
        style={{ background: "var(--color-dojo-raised)", border: "none" }}
      />
      <div style={{ marginTop: "9px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12.5px", lineHeight: 1.3, minHeight: "32px", color: "var(--color-dojo-ink)" }}>
        {c.name}
      </div>
      {showSet && (
        <div style={{ marginTop: "4px", fontSize: "10.5px", color: "var(--color-dojo-body)" }}>{setName}</div>
      )}
      <div style={{ marginTop: "9px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13.5px", fontVariantNumeric: "tabular-nums", color: c.marketPrice != null ? "var(--color-dojo-ink)" : "var(--color-dojo-faint)" }}>
        {c.marketPrice != null ? fmt(c.marketPrice) : "—"}
      </div>
      {/* Filled gold star — tap to unfavorite. */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRemove();
        }}
        disabled={isRemoving}
        aria-label={`Remove ${c.name} from favorites`}
        title="Remove from favorites"
        style={{
          position: "absolute",
          top: "8px",
          right: "8px",
          width: "28px",
          height: "28px",
          border: "1px solid var(--color-dojo-gold)",
          background: "var(--color-dojo-gold)",
          color: "var(--color-dojo-app)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "14px",
          lineHeight: 1,
        }}
      >
        ★
      </button>
    </Link>
  );
}

// ── Card tile — grid view ──────────────────────────────────────────
function CollectionCardGrid({
  item,
  isDeleting,
  onRemove,
}: {
  item: CollectionItem;
  isDeleting: boolean;
  onRemove: (id: string) => void;
}) {
  const price = item.card.marketPrice;
  const initials = cardInitials(item.card.name);
  const setName = item.card.set?.name;
  const showSet = setName && setName.toLowerCase() !== "unknown set";
  return (
    <Link
      href={detailHref(item)}
      className="dojo-card-tile"
      style={{
        position: "relative",
        background: "var(--color-dojo-card)",
        border: "1px solid var(--color-dojo-stroke)",
        padding: "11px",
        textDecoration: "none",
        display: "block",
      }}
    >
      <CardImage
        src={item.card.imageUrl}
        alt={item.card.name}
        initials={initials}
        style={{ background: "var(--color-dojo-raised)", border: "none" }}
      />
      <div style={{ marginTop: "9px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12.5px", lineHeight: 1.3, minHeight: "32px", color: "var(--color-dojo-ink)" }}>
        {item.card.name}
      </div>
      <div style={{ marginTop: "6px" }}>
        <GradeBadge condition={item.condition} />
      </div>
      <div style={{ marginTop: "4px", fontSize: "10.5px", color: "var(--color-dojo-body)" }}>
        {showSet ? setName : ""}{showSet && item.isFoil ? " · " : ""}{item.isFoil ? "Foil" : ""}
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
      {/* Remove button (Phase 1 fix) */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRemove(item.id);
        }}
        disabled={isDeleting}
        aria-label={`Remove ${item.card.name} from portfolio`}
        style={{
          position: "absolute",
          top: "8px",
          right: "8px",
          width: "24px",
          height: "24px",
          border: "1px solid var(--color-dojo-stroke)",
          background: "var(--color-dojo-card)",
          color: "var(--color-dojo-vermilion)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "14px",
          lineHeight: 1,
        }}
        title="Remove from portfolio"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true">
          <line x1="2" y1="2" x2="12" y2="12" />
          <line x1="12" y1="2" x2="2" y2="12" />
        </svg>
      </button>
    </Link>
  );
}

// ── Card row — list view ───────────────────────────────────────────
function CollectionCardList({
  item,
  isDeleting,
  onRemove,
}: {
  item: CollectionItem;
  isDeleting: boolean;
  onRemove: (id: string) => void;
}) {
  const price = item.card.marketPrice;
  const initials = cardInitials(item.card.name);
  const setName = item.card.set?.name;
  const showSet = setName && setName.toLowerCase() !== "unknown set";
  return (
    <Link
      href={detailHref(item)}
      className="dojo-card-tile"
      style={{
        position: "relative",
        background: "var(--color-dojo-card)",
        border: "1px solid var(--color-dojo-stroke)",
        padding: "12px 13px",
        marginBottom: "10px",
        display: "flex",
        gap: "12px",
        alignItems: "center",
        textDecoration: "none",
      }}
    >
      <div style={{ width: "40px", flex: "none" }}>
        <CardImage
          src={item.card.imageUrl}
          alt={item.card.name}
          initials={initials}
          aspectRatio="660 / 921"
          initialsSize="12px"
          style={{ background: "var(--color-dojo-raised)", border: "none" }}
        />
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
          <GradeBadge condition={item.condition} />
          <div style={{ flex: 1, minWidth: 0, fontSize: "11px", color: "var(--color-dojo-body)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {showSet ? setName : ""}{showSet && item.isFoil ? " · " : ""}{item.isFoil ? "Foil" : ""}
          </div>
          <GainLossTag item={item} />
        </div>
        <div style={{ marginTop: "6px", fontSize: "11px", color: "var(--color-dojo-faint)" }}>Qty: {item.quantity}</div>
      </div>
      {/* Remove button (Phase 1 fix) */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRemove(item.id);
        }}
        disabled={isDeleting}
        aria-label={`Remove ${item.card.name} from portfolio`}
        style={{
          position: "absolute",
          top: "8px",
          right: "8px",
          width: "24px",
          height: "24px",
          border: "1px solid var(--color-dojo-stroke)",
          background: "var(--color-dojo-card)",
          color: "var(--color-dojo-vermilion)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "14px",
          lineHeight: 1,
        }}
        title="Remove from portfolio"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true">
          <line x1="2" y1="2" x2="12" y2="12" />
          <line x1="12" y1="2" x2="2" y2="12" />
        </svg>
      </button>
    </Link>
  );
}

// Portfolio tabs (Phase 3.5). "sold" is a UI stub — no schema for sold
// cards yet, so it always renders an empty state.
// TODO Week 3: Implement real backend for sold-card tracking
//              (schema: add UserSale table with saleDate, salePrice,
//              buyer info, marketplace source).
type PortfolioTab = "my" | "favorites" | "sold";

// ── Favorite row shape — matches GET /api/users/me/favorites ──
interface FavoriteRow {
  id: string;
  cardId: string;
  createdAt: string;
  card: {
    id: string;
    externalId: string;
    name: string;
    rarity: string | null;
    imageUrl: string | null;
    imageUrlHi: string | null;
    marketPrice: number | null;
    set: { name: string } | null;
  };
}

// Collection "groups" (Want List / etc.) — UI stub with mock data so the
// client sees the vision (Phase 3 QA). "Main" is the user's real collection
// (backed by /api/users/me/collection); every other group is a placeholder
// until the backend lands. (Binders was removed in F-07 in favor of the
// Want List.)
type CollectionGroup = {
  id: string;
  name: string;
  /** null = real "Main" collection; a number = mock card count. */
  mockCount: number | null;
};
const COLLECTION_GROUPS: CollectionGroup[] = [
  { id: "main", name: "Main", mockCount: null },
  // Want List is real now (renders <WantList/>); it has its own per-intent
  // counts inside, so no chip badge here (-1 = "show nothing").
  { id: "wantlist", name: "Want List", mockCount: -1 },
  { id: "highvalue", name: "High Value", mockCount: 7 },
];

export default function PortfolioPage() {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [tab, setTab] = useState<PortfolioTab>("my");
  const [group, setGroup] = useState<string>("main");
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery<CollectionApiResponse>({
    queryKey: ["portfolio-collection"],
    queryFn: async () => {
      const res = await fetch("/api/users/me/collection");
      if (!res.ok) throw new Error("Failed to load collection");
      return res.json();
    },
  });

  // Delete mutation — removes a card from the user's collection.
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/users/me/collection/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete card");
      return res.json();
    },
    onSuccess: () => {
      // Invalidate portfolio collection so the list updates immediately,
      // plus the dashboard + /you collection stats (same data, different
      // query key) so removing a card propagates everywhere at once.
      queryClient.invalidateQueries({ queryKey: ["portfolio-collection"] });
      queryClient.invalidateQueries({ queryKey: ["collection"] });
    },
  });

  // Favorites — server-backed (shared ["favorites"] key with the star
  // buttons on search/detail, so starring anywhere shows up here).
  const { data: favData, isLoading: favLoading } = useQuery<{ favorites: FavoriteRow[] }>({
    queryKey: ["favorites"],
    queryFn: async () => {
      const res = await fetch("/api/users/me/favorites");
      if (!res.ok) throw new Error("Failed to load favorites");
      return res.json();
    },
  });
  const favorites = favData?.favorites ?? [];

  // Unfavorite from the Favorites tab (removes the star everywhere).
  const unfavoriteMutation = useMutation({
    mutationFn: async (externalId: string) => {
      const res = await fetch("/api/users/me/favorites", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ externalId }),
      });
      if (!res.ok) throw new Error("Failed to remove favorite");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["favorites"] }),
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

      {/* ── Collection groups (Want List / …) — UI stub ──
          Horizontal chip selector. "Main" shows the real collection;
          other groups are mock placeholders (Phase 3 QA). */}
      <div
        className="dojo-scroll-hidden"
        style={{ display: "flex", gap: "8px", overflowX: "auto", marginBottom: "16px", paddingBottom: "2px" }}
      >
        {COLLECTION_GROUPS.map((g) => {
          const activeGroup = group === g.id;
          return (
            <button
              key={g.id}
              onClick={() => setGroup(g.id)}
              style={{
                flex: "none", display: "flex", alignItems: "center", gap: "7px",
                padding: "8px 13px", cursor: "pointer", whiteSpace: "nowrap",
                border: "1px solid " + (activeGroup ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"),
                background: activeGroup ? "rgba(233,180,59,0.08)" : "var(--color-dojo-card)",
                color: activeGroup ? "var(--color-dojo-gold)" : "var(--color-dojo-body)",
                fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "10px",
                letterSpacing: "0.12em", textTransform: "uppercase",
              }}
            >
              {g.name}
              <span style={{ fontWeight: 700, fontSize: "9px", color: "var(--color-dojo-faint)" }}>
                {g.mockCount == null ? (isLoading ? "" : items.length) : g.mockCount < 0 ? "" : g.mockCount}
              </span>
            </button>
          );
        })}
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
          {group === "main" ? (isLoading ? "—" : fmt(collTotal)) : "—"}
        </div>
      </div>

      {/* Non-"Main" groups are UI stubs — show a styled "coming soon"
          state instead of the real collection (Phase 3 QA). Rendered as
          an early return-in-place so the real tabs/content below only
          run for the "Main" group. */}
      {group === "wantlist" ? (
        // F-07: the "Want List" group renders the real Want List (Buy/Sell/
        // Trade tabs) — same component as the /wantlist route, minus its
        // page heading since the portfolio header is already above.
        <div style={{ marginTop: "22px" }}>
          <WantList heading={false} />
        </div>
      ) : group !== "main" ? (
        <div style={{ border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)", padding: "40px 22px", textAlign: "center", marginTop: "22px" }}>
          <p className="dojo-heading" style={{ fontSize: "20px", margin: 0, color: "var(--color-dojo-gold)" }}>
            {COLLECTION_GROUPS.find((g) => g.id === group)?.name} coming soon
          </p>
          <p className="dojo-body" style={{ marginTop: "10px", marginBottom: 0, fontSize: "13px", lineHeight: 1.55 }}>
            organize cards into custom groups like
            high-value trackers. this is a preview — full group support
            lands soon.
          </p>
        </div>
      ) : (
      <>

      {/* ── My cards / Favorites / Sold tab switcher ── */}
      <div style={{ display: "flex", gap: "6px", margin: "22px 0 4px" }}>
        {([
          { id: "my" as const,        label: "My cards" },
          { id: "favorites" as const, label: "Favorites" },
          { id: "sold" as const,      label: "Sold" },
        ]).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              flex: "none", padding: "8px 14px", cursor: "pointer",
              border: "1px solid var(--color-dojo-stroke)",
              fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "10px",
              letterSpacing: "0.14em", textTransform: "uppercase",
              background: tab === t.id ? "var(--color-dojo-gold)" : "transparent",
              color: tab === t.id ? "var(--color-dojo-app)" : "var(--color-dojo-body)",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Item count + view toggle (only on My cards tab) ── */}
      {tab === "my" && (
        <div style={{ display: "flex", alignItems: "center", gap: "10px", margin: "14px 0 12px" }}>
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
                color: view === "list" ? "var(--color-dojo-app)" : "var(--color-dojo-faint)",
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
                color: view === "grid" ? "var(--color-dojo-app)" : "var(--color-dojo-faint)",
                boxShadow: view === "grid" ? "none" : "inset 0 0 0 1px var(--color-dojo-stroke)",
              }}
            >
              <GridIcon />
            </button>
          </div>
        </div>
      )}

      {/* ── Favorites tab: server-backed starred cards ── */}
      {tab === "favorites" ? (
        favLoading ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginTop: "18px" }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} style={{ background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "11px" }}>
                <div style={{ width: "100%", aspectRatio: "660 / 921", background: "var(--color-dojo-raised)", animation: "dojo-pulse 1.5s ease-in-out infinite" }} />
              </div>
            ))}
          </div>
        ) : favorites.length === 0 ? (
          <div style={{ border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)", padding: "40px 22px", textAlign: "center", marginTop: "18px" }}>
            <p className="dojo-heading" style={{ fontSize: "20px", margin: 0, color: "var(--color-dojo-gold)" }}>
              no favorites yet
            </p>
            <p className="dojo-body" style={{ marginTop: "10px", marginBottom: "18px", fontSize: "13px", lineHeight: 1.55 }}>
              tap the ★ on any card to save it here for quick access.
            </p>
            <Link href="/search" className="dojo-btn dojo-btn-primary" style={{ textDecoration: "none", display: "inline-flex", width: "auto", padding: "12px 22px" }}>
              BROWSE CARDS
            </Link>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginTop: "18px" }}>
            {favorites.map((f) => (
              <FavoriteCardGrid
                key={f.id}
                fav={f}
                isRemoving={unfavoriteMutation.isPending}
                onRemove={() => unfavoriteMutation.mutate(f.card.externalId)}
              />
            ))}
          </div>
        )
      ) : /* ── Sold tab: empty-state stub (Phase 3.5)
          TODO Week 3: Implement real backend for sold-card tracking. ── */
      tab === "sold" ? (
        <div style={{ border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)", padding: "40px 22px", textAlign: "center", marginTop: "18px" }}>
          <p className="dojo-heading" style={{ fontSize: "20px", margin: 0, color: "var(--color-dojo-gold)" }}>
            no sold cards yet
          </p>
          <p className="dojo-body" style={{ marginTop: "10px", marginBottom: 0, fontSize: "13px", lineHeight: 1.55 }}>
            cards you sell on the Floor will appear here — with the sale date, price, and total realized gain.
          </p>
        </div>
      ) : isLoading ? (
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
          {filteredItems.map((item) => (
            <CollectionCardGrid
              key={item.id}
              item={item}
              isDeleting={deleteMutation.isPending}
              onRemove={deleteMutation.mutate}
            />
          ))}
        </div>
      ) : (
        <div>
          {filteredItems.map((item) => (
            <CollectionCardList
              key={item.id}
              item={item}
              isDeleting={deleteMutation.isPending}
              onRemove={deleteMutation.mutate}
            />
          ))}
        </div>
      )}
      </>
      )}
    </div>
  );
}
