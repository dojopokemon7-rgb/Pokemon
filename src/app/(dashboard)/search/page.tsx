"use client";

/**
 * Screen 06 + 07 — Search / Explore
 *
 * - No `?q` param → Screen 06 empty state: layout ported from
 *   dojo-prototype/app.js `searchEmpty()` / `trendCard()` — a
 *   "Trending this week" 2-column grid (star-to-track, tap-plus-to-add),
 *   with a CONTINUE/Skip footer during onboarding.
 *
 *   DATA SOURCE: the reference backs this grid with a hardcoded 5-card
 *   mock array (CARD_DATA — five Charizard variants used as prototype
 *   filler, never meant to be a real feed). This build instead calls
 *   `/api/cards/trending`, which reads the real seeded card catalog
 *   (prisma/seed.ts — ~70+ real Pokémon/One Piece cards) with offset
 *   pagination and a "Show more" control, so every seeded card is
 *   actually reachable instead of only ever showing 5.
 *
 *   NOTE: an earlier pass of this screen used copy from
 *   `.reference/dojo-design/site/index.html` ("add your first cards" /
 *   "search the catalog") — that file is a *superseded* marketing
 *   prototype, not the canonical one. The README is explicit that
 *   `dojo-prototype/` is "the thing you run"; this rebuild follows
 *   that source instead.
 *
 * - With `?q=charizard` → Screen 07: grid/list results, ported from
 *   `searchResults()` — view toggle (grid/list), selection footer bar
 *   with total + "ADD TO COLLECTION", same `trendCard()` tile.
 *
 * The game is inferred from the query (default: "pokemon").
 * Users can switch game tab to "onepiece".
 *
 * Calls /api/cards/search?game=pokemon&query=charizard via React Query
 * for live results, and /api/cards/trending for the empty-state grid.
 */

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useState, useRef, useEffect, Suspense } from "react";
import { CardImage, cardInitials } from "@/components/CardImage";
import { Toast } from "@/components/Toast";
import { useWantToBuy } from "@/lib/hooks/useWantToBuy";


// ── Icons for scan/filter buttons (new per client feedback) ────────
function ScanFrameIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <path d="M3 7V5a2 2 0 012-2h2" />
      <path d="M17 3h2a2 2 0 012 2v2" />
      <path d="M21 17v2a2 2 0 01-2 2h-2" />
      <path d="M7 21H5a2 2 0 01-2-2v-2" />
      <line x1="3" y1="12" x2="21" y2="12" />
    </svg>
  );
}
// Sort icon (up/down arrows) — replaces the old funnel/filter glyph so
// the control reads as "sort", which is what the sheet actually does
// (Phase 2 QA: change Filter icon to a Sort icon).
function SortIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <path d="M7 4v16" />
      <path d="M4 8l3-4 3 4" />
      <path d="M17 20V4" />
      <path d="M14 16l3 4 3-4" />
    </svg>
  );
}

// ── Types ──────────────────────────────────────────────────────────
// Matches NormalizedCardSchema on the server (card.validator.ts).
// The set NAME is carried in `setImage` despite the name — historical
// artefact from when the field held a URL. The `set` / `setName`
// aliases are kept for older callers that pre-dated this file.
interface CardResult {
  id: string;
  name: string;
  number?: string;
  set?: string;
  setName?: string;
  setImage?: string;
  imageUrl?: string;
  image?: string;
  marketPrice?: number;
  price?: number;
  rarity?: string;
  source?: string;
}

interface SearchApiResponse {
  cards: CardResult[];
  source?: string;
}

// ── Trending card shape — matches /api/cards/trending's response.
// `price`/`delta`/`up` are nullable: there is no real price-history
// pipeline yet, so the API never fabricates a delta for seeded cards
// that don't have one (see route.ts for the full rationale). ───────
interface TrendingCard {
  id: string;
  externalId: string;
  name: string;
  setImage: string;
  imageUrl: string | null;
  price: number | null;
  delta: string | null;
  up: boolean | null;
  rarity?: string | null;
}

interface TrendingApiResponse {
  cards: TrendingCard[];
  // Numeric OFFSET of the next page (items loaded so far), or null when
  // there is no further page. Offset pagination is honored for every sort
  // (F-04 fix); the client just echoes it back as `&cursor=`.
  nextCursor: number | null;
}

// ── Helpers ────────────────────────────────────────────────────────
type Game = "pokemon" | "onepiece";
// Must match the SortEnum in /api/cards/search/route.ts. If you add a
// new sort mode there, add it here too.
type SortKey = "trending" | "market_desc" | "market_asc" | "name_asc" | "recent";
// `trending` = real hot-right-now (ranked by recent collection-adds in
// the trending route). `recent` = most recently synced.
const SORT_LABELS: Record<SortKey, string> = {
  trending: "Trending",
  market_desc: "Price · High to Low",
  market_asc: "Price · Low to High",
  name_asc: "Name · A to Z",
  recent: "Recently Added",
};

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function fmtUSD(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

// ── Trend card tile — ported from trendCard() in app.js. Star toggles
// "track this card" (top-right), plus toggles selection for the
// CONTINUE/ADD TO COLLECTION flow (bottom-right of the price row). ──
function TrendCardTile({
  card,
  game,
  tracked,
  onToggleTrack,
  selected,
  onToggleSelect,
  onOpen,
}: {
  card: TrendingCard;
  game: Game;
  tracked: boolean;
  onToggleTrack: () => void;
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
}) {
  const initials = cardInitials(card.name);

  // F-08: clicking the tile opens the details popup in place (instead of
  // navigating to /search/[id]). The popup carries a "View full details"
  // link for users who want the deeper page.
  return (
    <div
      className="dojo-card-tile"
      data-testid="card-result"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      style={{
        position: "relative",
        background: "var(--color-dojo-card)",
        border: "1px solid var(--color-dojo-stroke)",
        padding: "13px",
        display: "flex",
        flexDirection: "column",
        cursor: "pointer",
      }}
    >
      {/* Star — track this card */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggleTrack(); }}
        title="Track this card"
        aria-pressed={tracked}
        style={{
          position: "absolute",
          top: "8px",
          right: "8px",
          zIndex: 2,
          width: "30px",
          height: "30px",
          border: "1px solid " + (tracked ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"),
          background: tracked ? "var(--color-dojo-gold)" : "var(--color-dojo-app)",
          color: tracked ? "var(--color-dojo-app)" : "var(--color-dojo-body)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          fontSize: "15px",
          lineHeight: 1,
          transition: "all 150ms",
        }}
      >
        {tracked ? "★" : "☆"}
      </button>

      {/* Card art — CardImage handles missing/broken src fallbacks to initials */}
      <div style={{ width: "62%", alignSelf: "center" }}>
        <CardImage
          src={card.imageUrl}
          alt={card.name}
          initials={initials}
          initialsSize="22px"
          style={{ background: "var(--color-dojo-raised)", border: "none" }}
        />
      </div>

      <div style={{ marginTop: "12px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "14.5px", lineHeight: 1.3, color: "var(--color-dojo-ink)" }}>
        {card.name}
      </div>
      {/* Client feedback: don't display set name if unknown/empty */}
      {card.setImage && card.setImage.toLowerCase() !== "unknown set" && (
        <div style={{ marginTop: "4px", fontSize: "11.5px", lineHeight: 1.45, color: "var(--color-dojo-body)" }}>
          {card.setImage}
        </div>
      )}

      <div style={{ marginTop: "12px", display: "flex", alignItems: "flex-end", gap: "8px" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "3px" }}>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontVariantNumeric: "tabular-nums", fontSize: "15px", color: card.price != null ? "var(--color-dojo-ink)" : "var(--color-dojo-faint)" }}>
            {card.price != null ? fmtUSD(card.price) : "—"}
          </div>
          {/* Client feedback: show value deviation on every tile. If the API
              returned a real delta, use it. Otherwise fall back to a
              deterministic mock derived from the card id (same card = same
              delta on every render).
              TODO Week 3: Replace mock with real PricingHistory calculations. */}
          {card.price != null && (() => {
            let deltaText: string;
            let up: boolean;
            if (card.delta != null && card.up != null) {
              deltaText = card.delta;
              up = card.up;
            } else {
              const seed = card.id.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
              const pct = ((seed % 190) - 90) / 10;
              up = pct >= 0;
              deltaText = `${up ? "+" : ""}${pct.toFixed(1)}%`;
            }
            return (
              <div
                style={{
                  fontFamily: "var(--font-display)",
                  fontWeight: 400,
                  fontVariantNumeric: "tabular-nums",
                  fontSize: "11px",
                  color: up ? "var(--color-dojo-jade)" : "var(--color-dojo-vermilion)",
                }}
              >
                {up ? "▲" : "▼"} {deltaText}
              </div>
            );
          })()}
        </div>
        {/* Plus — add to selection */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect();
          }}
          aria-pressed={selected}
          title="Add to collection"
          style={{
            flex: "none",
            width: "34px",
            height: "34px",
            borderRadius: "50%",
            border: "1.5px solid " + (selected ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"),
            background: selected ? "var(--color-dojo-gold)" : "var(--color-dojo-card)",
            color: selected ? "var(--color-dojo-app)" : "var(--color-dojo-body)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "17px",
            lineHeight: 1,
            cursor: "pointer",
            transition: "all 150ms",
          }}
        >
          {selected ? "✓" : "+"}
        </button>
      </div>
      {/* "Find on eBay" removed per client feedback — keep users in the
          app. The eBay deal-finder still lives on the card detail page. */}
    </div>
  );
}

// ── Filter / Sort bottom sheet ─────────────────────────────────────
// TODO: Price range and Set dropdown — both need extra API surface
// (price range: min/max on search route) and UI (multi-select dropdown
// with the actual set list). Skipped for the shortest useful diff;
// sort is the highest-leverage filter for a card catalogue.
function FilterSheet({
  currentSort,
  onSelect,
  onClose,
}: {
  currentSort: SortKey;
  onSelect: (next: SortKey) => void;
  onClose: () => void;
}) {
  // "Trending" first — the default, real hot-right-now ranking.
  const options: { key: SortKey; label: string }[] = [
    { key: "trending", label: SORT_LABELS.trending },
    { key: "recent", label: SORT_LABELS.recent },
    { key: "market_desc", label: SORT_LABELS.market_desc },
    { key: "market_asc", label: SORT_LABELS.market_asc },
    { key: "name_asc", label: SORT_LABELS.name_asc },
  ];
  return (
    <>
      {/* Scrim */}
      <button
        type="button"
        aria-label="Close filters"
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, zIndex: 90,
          background: "rgba(0,0,0,0.55)", border: "none", cursor: "pointer",
        }}
      />
      {/* Sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Filter and sort"
        style={{
          position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 91,
          background: "var(--color-dojo-card)",
          borderTop: "1px solid var(--color-dojo-stroke)",
          padding: "18px 22px 26px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: "14px" }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "12px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
            Sort by
          </span>
          {/* Scrim already provides the close affordance — no separate X
              button in the header (removed duplicate close icon, Phase 1). */}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {options.map((o) => {
            const active = o.key === currentSort;
            return (
              <button
                key={o.key}
                type="button"
                onClick={() => onSelect(o.key)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "14px 14px",
                  border: "1px solid " + (active ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"),
                  background: active ? "rgba(233,180,59,0.08)" : "var(--color-dojo-app)",
                  color: active ? "var(--color-dojo-gold)" : "var(--color-dojo-ink)",
                  fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12px",
                  letterSpacing: "0.10em", textTransform: "uppercase",
                  cursor: "pointer",
                }}
              >
                <span>{o.label}</span>
                {active && <span aria-hidden>✓</span>}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ── Skeleton Card ──────────────────────────────────────────────────
function SkeletonCard() {
  return (
    <div
      style={{
        background: "var(--color-dojo-card)",
        border: "1px solid var(--color-dojo-stroke)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div style={{ aspectRatio: "660 / 921", background: "var(--color-dojo-raised)", animation: "dojo-pulse 1.5s ease-in-out infinite" }} />
      <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: "6px" }}>
        <div style={{ height: "13px", background: "var(--color-dojo-raised)", width: "70%" }} />
        <div style={{ height: "11px", background: "var(--color-dojo-stroke)", width: "50%" }} />
        <div style={{ height: "14px", background: "var(--color-dojo-raised)", width: "40%", marginTop: "2px" }} />
      </div>
    </div>
  );
}

// ── Card Grid Tile ─────────────────────────────────────────────────
// Fades/slides up on mount, staggered by grid position. The reference
// prototype's grid never animates (searchResults() inserts static
// markup) — this is a new addition, documented in ANIMATION_SPECS.md.
function CardTile({
  card,
  index = 0,
  game,
  onAdd,
  tracked,
  onToggleTrack,
  onOpen,
}: {
  card: CardResult;
  index?: number;
  game: Game;
  onAdd: (card: CardResult) => void;
  tracked: boolean;
  onToggleTrack: () => void;
  onOpen: () => void;
}) {
  const imgSrc = card.imageUrl ?? card.image;
  const price = card.marketPrice ?? card.price ?? 0;
  // NormalizedCard on the server carries the set NAME in `setImage`.
  // Prefer that; fall back to legacy `setName`/`set` aliases.
  const setName = card.setImage ?? card.setName ?? card.set ?? "";
  const initials = cardInitials(card.name);

  // There is no GET-by-id card API (only /api/cards/search), so the
  // card's own search-result fields are carried forward via query
  // params to the detail page rather than re-fetched. This mirrors the
  // reference's approach in spirit — SCREENS.card reads from a single
  // in-memory CARD object already available to the whole app, not a
  // fresh network fetch per card.
  //
  // `game` is threaded through so the detail page shows the right franchise
  // name; `number`/`rarity` feed the detail page's serial line.
  const detailParams = new URLSearchParams({
    name: card.name,
    game,
    ...(setName ? { set: setName } : {}),
    ...(imgSrc ? { img: imgSrc } : {}),
    ...(price ? { price: String(price) } : {}),
    ...(card.number ? { number: card.number } : {}),
    ...(card.rarity ? { rarity: card.rarity } : {}),
  });

  return (
    <Link
      href={`/search/${card.id}?${detailParams.toString()}`}
      className="dojo-card-tile"
      data-testid="card-result"
      // Tapping the tile navigates to the full card detail page. The href
      // already points there (so middle-click / open-in-new-tab works); the
      // plain click is intercepted only so we can route through goToCard,
      // which threads price/image/etc. as query params.
      onClick={(e) => {
        e.preventDefault();
        onOpen();
      }}
      style={{
        background: "var(--color-dojo-card)",
        border: "1px solid var(--color-dojo-stroke)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        textDecoration: "none",
        animation: "dojo-fade-up 260ms ease-out both",
        animationDelay: `${Math.min(index, 12) * 35}ms`,
      }}
    >
      {/* Card image via shared CardImage — handles broken URLs by
          swapping in the gold initials placeholder. */}
      <div style={{ position: "relative" }}>
        <CardImage
          src={imgSrc}
          alt={card.name}
          initials={initials}
          aspectRatio="660 / 921"
          initialsSize="26px"
          style={{ background: "var(--color-dojo-raised)", border: "none" }}
        />
        {/* Star — adds this card to Want to Buy (replaced favourites).
            Matches the trending tile's star exactly. */}
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleTrack(); }}
          title="Track this card"
          aria-pressed={tracked}
          style={{
            position: "absolute",
            top: "8px",
            right: "8px",
            zIndex: 2,
            width: "30px",
            height: "30px",
            border: "1px solid " + (tracked ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"),
            background: tracked ? "var(--color-dojo-gold)" : "var(--color-dojo-app)",
            color: tracked ? "var(--color-dojo-app)" : "var(--color-dojo-body)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            fontSize: "15px",
            lineHeight: 1,
            transition: "all 150ms",
          }}
        >
          {tracked ? "★" : "☆"}
        </button>
        {/* Add button overlay — functional (Phase 1 fix). Opens the
            AddCardSheet to pick Ungraded/Graded before adding. Moved to
            the top-left so it never collides with the star, keeping the
            tile identical to the trending grid (Phase 2 QA). */}
        <button
          type="button"
          aria-label={`Add ${card.name} to portfolio`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onAdd(card);
          }}
          style={{
            position: "absolute",
            top: "8px",
            left: "8px",
            width: "24px",
            height: "24px",
            border: "1px solid var(--color-dojo-stroke)",
            background: "var(--color-dojo-card)",
            color: "var(--color-dojo-body)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <line x1="6" y1="1" x2="6" y2="11" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" />
            <line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" />
          </svg>
        </button>
      </div>

      {/* Card info */}
      <div style={{ padding: "10px 12px" }}>
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: "13px",
            lineHeight: 1.3,
            color: "var(--color-dojo-ink)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {card.name}
        </div>
        {/* Client feedback: hide set name if unknown/empty */}
        {setName && setName.toLowerCase() !== "unknown set" && (
          <div data-testid="card-result-set" style={{ marginTop: "-2px", fontSize: "11px", color: "var(--color-dojo-body)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {setName}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "baseline", gap: "6px", marginTop: "4px" }}>
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 800,
              fontSize: "14px",
              fontVariantNumeric: "tabular-nums",
              color: price > 0 ? "var(--color-dojo-gold)" : "var(--color-dojo-faint)",
            }}
          >
            {price > 0
              ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(price)
              : "—"}
          </span>
          {/* Client feedback: display value deviation delta on each tile.
              Deterministic mock derived from card.id so the same card always
              shows the same delta (not jittery on re-render).
              TODO Week 3: Replace with real PricingHistory calculations. */}
          {price > 0 && (() => {
            const seed = card.id.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
            const pct = ((seed % 190) - 90) / 10; // range: -9.0% .. +9.0%
            const up = pct >= 0;
            return (
              <span
                style={{
                  marginLeft: "auto",
                  fontFamily: "var(--font-display)",
                  fontWeight: 700,
                  fontSize: "10px",
                  letterSpacing: "0.08em",
                  color: up ? "var(--color-dojo-jade)" : "var(--color-dojo-vermilion)",
                }}
              >
                {up ? "▲" : "▼"} {up ? "+" : ""}{pct.toFixed(1)}%
              </span>
            );
          })()}
        </div>
        {/* "Find on eBay" removed per client feedback — keep users in the
            app. The eBay deal-finder still lives on the card detail page. */}
      </div>
    </Link>
  );
}

// ── Recent searches (F-05) — persisted in localStorage ─────────────
const RECENT_SEARCHES_KEY = "dojo-recent-searches";
const RECENT_SEARCHES_MAX = 5;

function readRecentSearches(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_SEARCHES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function pushRecentSearch(query: string): string[] {
  const q = query.trim();
  if (!q || typeof window === "undefined") return readRecentSearches();
  // Most-recent-first, de-duplicated case-insensitively, capped.
  const existing = readRecentSearches().filter((r) => r.toLowerCase() !== q.toLowerCase());
  const next = [q, ...existing].slice(0, RECENT_SEARCHES_MAX);
  try {
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
  } catch {
    /* storage full / disabled — non-fatal, suggestions just won't persist */
  }
  return next;
}

// ── Search bar ─────────────────────────────────────────────────────
function SearchBar({ defaultValue, game, onSearch, onClear }: {
  defaultValue?: string;
  game: Game;
  onSearch: (q: string) => void;
  onClear?: () => void;
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  const [focused, setFocused] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  // Debounced copy of `value` that actually drives the autocomplete query,
  // so we don't fire a suggestions request on every keystroke.
  const [suggestQuery, setSuggestQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // F-05: debounce as-you-type search so a burst of keystrokes collapses
  // into one request once the user pauses (~350ms). Enter still fires
  // immediately. The timer lives in a ref so it survives re-renders.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
  };
  // Clear any pending timer on unmount so it can't fire after teardown.
  useEffect(() => clearTimer, []);

  // Load recent searches from localStorage on mount (client-only).
  useEffect(() => setRecent(readRecentSearches()), []);

  // Close the dropdown on an outside click.
  useEffect(() => {
    if (!focused) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [focused]);

  // F-05 autocomplete: fetch matching cards for the debounced query and
  // derive up to 5 unique suggestions (card names + set names). Reuses the
  // same local-catalog search endpoint the results grid uses; React Query
  // dedupes/caches by key. Never throws into the UI — 404/no-match → [].
  const trimmedSuggest = suggestQuery.trim();
  const { data: suggestions = [] } = useQuery<string[]>({
    queryKey: ["search-suggest", game, trimmedSuggest],
    enabled: trimmedSuggest.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const res = await fetch(
        `/api/cards/search?game=${game}&query=${encodeURIComponent(trimmedSuggest)}&sort=market_desc`
      );
      if (!res.ok) return [];
      const json = (await res.json()) as SearchApiResponse;
      const seen = new Set<string>();
      const out: string[] = [];
      for (const c of json.cards ?? []) {
        for (const label of [c.name, c.setImage]) {
          const l = (label ?? "").trim();
          if (l && l.toLowerCase() !== "unknown set" && !seen.has(l.toLowerCase())) {
            seen.add(l.toLowerCase());
            out.push(l);
          }
          if (out.length >= 5) break;
        }
        if (out.length >= 5) break;
      }
      return out;
    },
  });

  const handleChange = (raw: string) => {
    setValue(raw);
    clearTimer();
    const q = raw.trim();
    debounceRef.current = setTimeout(() => {
      setSuggestQuery(q); // drives the autocomplete query
      if (q) onSearch(q);
      else onClear?.();
    }, 350);
  };

  // Commit a query: fill the input, persist to recent, run the search,
  // and close the dropdown. Used by Enter and by tapping a suggestion.
  const commit = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    clearTimer();
    setValue(trimmed);
    setRecent(pushRecentSearch(trimmed));
    setFocused(false);
    inputRef.current?.blur();
    onSearch(trimmed);
  };

  // What the dropdown shows: live suggestions while typing, else the
  // recent searches when the field is focused but empty.
  const showTyping = value.trim().length > 0;
  const rows = showTyping ? suggestions : recent;
  const open = focused && rows.length > 0;

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          commit(value); // fire now, don't double-fire via the debounce
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          border: "1px solid var(--color-dojo-stroke)",
          background: "var(--color-dojo-card)",
          padding: "12px 14px",
          color: "var(--color-dojo-ink)",
        }}
      >
        {/* Search icon */}
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true" style={{ color: "rgba(255,255,255,0.5)", flexShrink: 0 }}>
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        {/* No autoFocus — the explore page must not pop the mobile
            keyboard on mount; it opens only when the user taps the field
            (Phase 2 QA: prevent keyboard auto-trigger on Explore). */}
        <input
          ref={inputRef}
          type="search"
          className="dojo-search-input"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={(e) => { if (e.key === "Escape") setFocused(false); }}
          placeholder="charizard"
          // Keep the native `searchbox` role (type="search"); expose the
          // autocomplete relationship without overriding the role so
          // assistive tech and role-based selectors still see a searchbox.
          aria-autocomplete="list"
          aria-controls="search-suggestions"
          aria-expanded={open}
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            fontFamily: "var(--font-display)",
            fontWeight: 600,
            fontSize: "14px",
            color: "var(--color-dojo-ink)",
            caretColor: "var(--color-dojo-gold)",
          }}
          aria-label="Search cards"
        />
      </form>

      {/* F-05 autocomplete / recent-searches dropdown. Dark theme, 0px
          radius, display font — mirrors the .dojo-menu popover styling. */}
      {open && (
        <div
          id="search-suggestions"
          data-testid="search-suggestions"
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 30,
            background: "var(--color-dojo-raised)",
            border: "1px solid var(--color-dojo-stroke)",
            boxShadow: "5px 5px 0 0 #000",
            maxHeight: "260px",
            overflowY: "auto",
            animation: "dojo-fade-in 160ms ease-out both",
          }}
        >
          {!showTyping && (
            <div style={{ padding: "9px 13px 5px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
              Recent
            </div>
          )}
          {rows.map((label) => (
            <button
              key={label}
              type="button"
              role="option"
              aria-selected={false}
              data-testid="search-suggestion"
              // onMouseDown (not onClick) so it fires before the input's
              // blur/outside-click closes the dropdown.
              onMouseDown={(e) => { e.preventDefault(); commit(label); }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                width: "100%",
                textAlign: "left",
                padding: "11px 13px",
                background: "transparent",
                border: "none",
                borderTop: "1px solid var(--color-dojo-divider)",
                cursor: "pointer",
                fontFamily: "var(--font-display)",
                fontWeight: 700,
                fontSize: "12.5px",
                color: "var(--color-dojo-ink)",
              }}
            >
              {/* leading glyph: clock for recent, magnifier for suggestions */}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true" style={{ color: "var(--color-dojo-faint)", flexShrink: 0 }}>
                {showTyping ? (
                  <>
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </>
                ) : (
                  <>
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7v5l3 3" />
                  </>
                )}
              </svg>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {label}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Inner page (reads searchParams) ───────────────────────────────
function SearchPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialQ = searchParams.get("q") ?? "";
  const hasQuery = initialQ.trim().length > 0;
  const [game, setGame] = useState<Game>(
    (searchParams.get("game") as Game) || "pokemon"
  );
  // F-06: active filters, all driven by URL params so the page reacts to
  // them and they survive refresh / deep-linking.
  const setFilter = searchParams.get("set") ?? "";
  const rarityFilter = searchParams.get("rarity") ?? "";
  const gradedFilter = searchParams.get("graded") ?? ""; // "" | "graded" | "ungraded"
  const minPriceFilter = searchParams.get("minPrice") ?? "";
  const maxPriceFilter = searchParams.get("maxPrice") ?? "";

  // Sort state — persisted only in memory. Query keys below include
  // `sort` so switching the filter sheet triggers a refetch without a
  // URL bounce. Default `recent` matches the trending route's own
  // default so the grid opens the way users expect (most recently
  // synced first) and the filter chip only appears once they've
  // actively re-sorted.
  const [sort, setSort] = useState<SortKey>("trending");
  const [filterOpen, setFilterOpen] = useState(false);

  // "Track this card" (star) adds the card to the user's Want to Buy list
  // (server-backed, viewable on /wantlist and the dashboard tabs) — this
  // replaced the removed favourites feature. "add to selection" (plus)
  // stays local.
  const { isWanted, toggle: toggleWant } = useWantToBuy();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Client feedback: + on a card now opens a bottom sheet to pick
  // Ungraded / Graded. This state tracks which card the sheet is for
  // (null = sheet closed). See AddCardSheet at the bottom of the page.
  // Union type: the trending grid passes TrendingCard, the results grid
  // passes CardResult — both are handled by AddCardSheet.
  const [addSheetCard, setAddSheetCard] = useState<TrendingCard | CardResult | null>(null);
  const [addToast, setAddToast] = useState<string | null>(null);

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Tapping a card tile navigates straight to the full detail page
  // (/search/[id]) — the intermediate quick-view popup was removed. Card
  // identity/price/image ride along as query params (there is no
  // get-by-id API; the detail page reads them from the URL).
  const goToCard = (c: {
    id: string;
    name: string;
    setName?: string;
    imageUrl?: string;
    marketPrice?: number | null;
    rarity?: string;
  }) => {
    const params = new URLSearchParams({ name: c.name, game });
    if (c.setName) params.set("set", c.setName);
    if (c.imageUrl) params.set("img", c.imageUrl);
    if (c.marketPrice != null) params.set("price", String(c.marketPrice));
    if (c.rarity) params.set("rarity", c.rarity);
    router.push(`/search/${encodeURIComponent(c.id)}?${params.toString()}`);
  };

  const doSearch = (q: string) => {
    router.replace(`/search?q=${encodeURIComponent(q)}&game=${game}`);
  };
  const clearSearch = () => {
    router.replace("/search");
  };

  // Real, paginated trending feed — backed by the seeded database
  // (see /api/cards/trending), not the reference's fixed 5-card mock.
  const {
    data: trendingPages,
    isLoading: trendingLoading,
    isError: trendingError,
    fetchNextPage: fetchMoreTrending,
    hasNextPage: hasMoreTrending,
    isFetchingNextPage: fetchingMoreTrending,
  } = useInfiniteQuery<TrendingApiResponse>({
    // Query key includes `game` + `sort` so switching either refetches
    // (and doesn't reuse cache from the other game / previous order).
    queryKey: ["trending-cards", game, sort],
    queryFn: async ({ pageParam }) => {
      const cursorParam = pageParam != null ? `&cursor=${pageParam}` : "";
      const res = await fetch(
        `/api/cards/trending?limit=10&game=${game}&sort=${sort}${cursorParam}`
      );
      if (!res.ok) throw new Error("Failed to load trending cards");
      return res.json();
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !hasQuery,
  });

  // Flatten paginated trending pages, de-duplicating by externalId so a
  // card can never render twice even if the curated page 1 and a later
  // catalog page happen to overlap (F-04: zero duplicates on Show More).
  const trendingCards = (() => {
    const seen = new Set<string>();
    const out: TrendingCard[] = [];
    for (const p of trendingPages?.pages ?? []) {
      for (const c of p.cards) {
        if (seen.has(c.externalId)) continue;
        seen.add(c.externalId);
        out.push(c);
      }
    }
    return out;
  })();

  const { data, isFetching, isError } = useQuery<SearchApiResponse>({
    queryKey: ["card-search", game, initialQ, sort, setFilter, rarityFilter, gradedFilter, minPriceFilter, maxPriceFilter],
    queryFn: async () => {
      // Compose the optional F-06 filter params only when set.
      const params = new URLSearchParams({ game, query: initialQ, sort });
      if (setFilter) params.set("set", setFilter);
      if (rarityFilter) params.set("rarity", rarityFilter);
      if (gradedFilter) params.set("graded", gradedFilter);
      if (minPriceFilter) params.set("minPrice", minPriceFilter);
      if (maxPriceFilter) params.set("maxPrice", maxPriceFilter);
      const res = await fetch(`/api/cards/search?${params.toString()}`);
      if (!res.ok) {
        if (res.status === 404) return { cards: [] };
        throw new Error("Search failed");
      }
      return res.json();
    },
    enabled: initialQ.trim().length > 0,
  });

  const cards = data?.cards ?? [];

  // F-06: options for the "Filter by set" dropdown. When no set filter is
  // active the current results span every set, so we remember that full set
  // list in state; while a filter IS active the API returns only that set,
  // so we reuse the remembered list to keep every option (and "All sets")
  // reachable. State — not a ref — so populating it re-renders the control.
  const [knownSets, setKnownSets] = useState<string[]>([]);
  useEffect(() => {
    if (setFilter || cards.length === 0) return;
    const names = Array.from(
      new Set(
        cards
          .map((c) => c.setImage ?? c.setName ?? c.set ?? "")
          .filter((n) => n && n.toLowerCase() !== "unknown set")
      )
    ).sort();
    // Only update when the set list actually changed (avoid a render loop).
    setKnownSets((prev) =>
      prev.length === names.length && prev.every((v, i) => v === names[i]) ? prev : names
    );
  }, [setFilter, cards]);
  // Always include the active filter so it stays selectable (e.g. a
  // deep-linked ?set= whose set wasn't in the remembered list).
  const setOptions = Array.from(
    new Set([...knownSets, ...(setFilter ? [setFilter] : [])])
  ).sort();

  // F-06: apply one or more filter changes at once, preserving the query,
  // game, and every other active filter. Pass "" to clear a given filter.
  const applyFilters = (
    overrides: Partial<{ set: string; rarity: string; graded: string; minPrice: string; maxPrice: string }>
  ) => {
    const current = {
      set: setFilter,
      rarity: rarityFilter,
      graded: gradedFilter,
      minPrice: minPriceFilter,
      maxPrice: maxPriceFilter,
      ...overrides,
    };
    const params = new URLSearchParams();
    if (initialQ) params.set("q", initialQ);
    params.set("game", game);
    for (const [k, v] of Object.entries(current)) {
      if (v) params.set(k, v);
    }
    router.replace(`/search?${params.toString()}`);
  };
  const applySetFilter = (nextSet: string) => applyFilters({ set: nextSet });

  // Rarity options: unique rarities present in the (unfiltered) results,
  // remembered the same way sets are so they stay selectable while filtered.
  const [knownRarities, setKnownRarities] = useState<string[]>([]);
  useEffect(() => {
    if (rarityFilter || cards.length === 0) return;
    const rs = Array.from(
      new Set(cards.map((c) => (c.rarity ?? "").trim()).filter((r) => r && r.toLowerCase() !== "unknown"))
    ).sort();
    setKnownRarities((prev) =>
      prev.length === rs.length && prev.every((v, i) => v === rs[i]) ? prev : rs
    );
  }, [rarityFilter, cards]);
  const rarityOptions = Array.from(
    new Set([...knownRarities, ...(rarityFilter ? [rarityFilter] : [])])
  ).sort();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {/* ── Sticky search bar with scan/filter buttons (per client feedback) ── */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          padding: "12px 22px",
          background: "var(--color-dojo-app)",
          borderBottom: hasQuery ? "1px solid var(--color-dojo-divider)" : "none",
        }}
      >
        {/* Row with search input + scan icon + filter icon */}
        <div style={{ display: "flex", alignItems: "stretch", gap: "8px" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <SearchBar defaultValue={initialQ} game={game} onSearch={doSearch} onClear={clearSearch} />
          </div>
          <Link
            href="/scanner"
            aria-label="Scan a card"
            title="Scan"
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: "44px", flex: "none",
              border: "1px solid var(--color-dojo-stroke)",
              background: "var(--color-dojo-card)",
              color: "var(--color-dojo-ink)",
              textDecoration: "none",
            }}
          >
            <ScanFrameIcon />
          </Link>
          <button
            type="button"
            aria-label="Sort"
            title="Sort"
            onClick={() => setFilterOpen(true)}
            style={{
              position: "relative",
              display: "flex", alignItems: "center", justifyContent: "center",
              width: "44px", flex: "none",
              border: "1px solid " + (sort !== "trending" ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"),
              background: "var(--color-dojo-card)",
              color: sort !== "trending" ? "var(--color-dojo-gold)" : "var(--color-dojo-ink)",
              cursor: "pointer",
            }}
          >
            <SortIcon />
            {sort !== "trending" && (
              <span aria-hidden style={{ position: "absolute", top: 4, right: 4, width: 6, height: 6, background: "var(--color-dojo-gold)" }} />
            )}
          </button>
        </div>

        {/* Game tabs — shown on BOTH empty (trending) and results states
            so switching Pokémon/One Piece works everywhere and doesn't
            leak cards from the other game. */}
        <div style={{ display: "flex", gap: "0", marginTop: "10px" }}>
          {(["pokemon", "onepiece"] as Game[]).map((g) => (
            <button
              key={g}
              onClick={() => {
                setGame(g);
                if (hasQuery) {
                  router.replace(`/search?q=${encodeURIComponent(initialQ)}&game=${g}`);
                } else {
                  router.replace(`/search?game=${g}`);
                }
              }}
              style={{
                flex: 1,
                padding: "8px 0",
                fontFamily: "var(--font-display)", fontWeight: 700, fontStretch: "112%",
                fontSize: "9.5px", letterSpacing: "0.14em", textTransform: "uppercase",
                background: "transparent", border: "none",
                borderBottom: game === g ? "2px solid var(--color-dojo-gold)" : "2px solid transparent",
                color: game === g ? "var(--color-dojo-ink)" : "var(--color-dojo-faint)",
                cursor: "pointer",
              }}
            >
              {g === "pokemon" ? "Pokémon" : "One Piece"}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: "0 22px 24px" }}>
        {/* ── Screen 06: Empty state — "Trending this week" ──
            Layout ported from searchEmpty()/trendCard() in
            dojo-prototype/app.js, backed by the real seeded catalog
            via /api/cards/trending instead of the reference's fixed
            5-card mock — see file header for the full rationale. */}
        {!hasQuery && (
          <>
            <div style={{ display: "flex", alignItems: "baseline", marginTop: "16px" }}>
              <span
                style={{
                  fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px",
                  letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-body)",
                }}
              >
                Trending this week
              </span>
              {/* Multi-select entry point on the Explore landing too — it
                  used to appear only after searching, so bulk-add was
                  effectively hidden. Routes to the multi list for the
                  current game. */}
              <Link
                href={`/search/multi?game=${game}`}
                style={{
                  marginLeft: "auto",
                  fontFamily: "var(--font-display)", fontWeight: 700, fontStretch: "112%",
                  fontSize: "9px", letterSpacing: "0.14em", textTransform: "uppercase",
                  color: "var(--color-dojo-gold)", textDecoration: "none",
                }}
              >
                Multi-select ›
              </Link>
            </div>

            <div className="dojo-card-grid" style={{ marginTop: "12px" }}>
              {trendingLoading
                ? Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)
                : trendingError
                ? (
                  <div style={{ gridColumn: "1/-1", textAlign: "center", padding: "40px 0", color: "var(--color-dojo-body)" }}>
                    <p style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13px" }}>
                      Could not load trending cards. Check your connection and try again.
                    </p>
                  </div>
                )
                : trendingCards.length === 0
                ? (
                  <div style={{ gridColumn: "1/-1", textAlign: "center", padding: "40px 0", color: "var(--color-dojo-body)" }}>
                    <p style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13px" }}>
                      No cards in the catalog yet.
                    </p>
                  </div>
                )
                : trendingCards.map((card) => (
                  <TrendCardTile
                    key={card.id}
                    card={card}
                    game={game}
                    tracked={isWanted(card.externalId)}
                    onToggleTrack={() => {
                      const next = toggleWant({
                        externalId: card.externalId,
                        name: card.name,
                      });
                      setAddToast(next ? "Added to Want to Buy" : "Removed from Want to Buy");
                    }}
                    selected={selected.has(card.id)}
                    // Client feedback: + now opens a bottom sheet to pick
                    // Ungraded / Graded for this specific card.
                    onToggleSelect={() => setAddSheetCard(card)}
                    // Tile click navigates straight to the card detail page.
                    onOpen={() =>
                      goToCard({
                        id: card.externalId,
                        name: card.name,
                        setName: card.setImage || undefined,
                        imageUrl: card.imageUrl || undefined,
                        marketPrice: card.price ?? null,
                        rarity: card.rarity ?? undefined,
                      })
                    }
                  />
                ))}
            </div>

            {/* Show more — real keyset pagination through the full
                seeded catalog (the reference has no pagination here
                since its mock array only ever had 5 cards). */}
            {!trendingLoading && !trendingError && hasMoreTrending && (
              <div style={{ marginTop: "14px", display: "flex", justifyContent: "center" }}>
                <button
                  onClick={() => fetchMoreTrending()}
                  disabled={fetchingMoreTrending}
                  className="dojo-btn dojo-btn-outline"
                  style={{ width: "auto", padding: "10px 24px" }}
                >
                  {fetchingMoreTrending ? "LOADING…" : "SHOW MORE"}
                </button>
              </div>
            )}

            {/* CONTINUE / Skip footer — trending/empty state only (hidden
                during active search per client feedback). Since + now
                opens a bottom sheet to add a single card directly, this
                footer is just the "I'm done browsing" affordance. */}
            <div style={{ display: "flex", flexDirection: "column", gap: "14px", padding: "18px 0 4px" }}>
              <button
                onClick={() => router.push("/dashboard")}
                className="dojo-btn dojo-btn-primary"
              >
                CONTINUE
              </button>
              <Link
                href="/dashboard"
                style={{
                  textAlign: "center",
                  fontFamily: "var(--font-display)", fontWeight: 700, fontStretch: "112%",
                  fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase",
                  color: "var(--color-dojo-faint)", textDecoration: "none", cursor: "pointer",
                }}
              >
                Skip
              </Link>
            </div>
          </>
        )}

        {/* ── Screen 07: Results ── */}
        {hasQuery && (
          <>
            {/* Results header */}
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "12px", marginBottom: "10px" }}>
              <span
                style={{
                  fontFamily: "var(--font-display)", fontWeight: 700, fontStretch: "112%",
                  fontSize: "9.5px", letterSpacing: "0.14em", textTransform: "uppercase",
                  color: "var(--color-dojo-faint)",
                }}
              >
                {isFetching
                  ? "Searching…"
                  : isError
                  ? "Error"
                  : `${cards.length} result${cards.length !== 1 ? "s" : ""}`}
              </span>
              {sort !== "trending" && (
                <button
                  type="button"
                  onClick={() => setSort("trending")}
                  title="Clear sort"
                  style={{
                    display: "inline-flex", alignItems: "center", gap: "6px",
                    background: "rgba(233,180,59,0.10)",
                    border: "1px solid var(--color-dojo-gold)",
                    color: "var(--color-dojo-gold)",
                    padding: "4px 8px",
                    fontFamily: "var(--font-display)", fontWeight: 700,
                    fontSize: "9.5px", letterSpacing: "0.10em", textTransform: "uppercase",
                    cursor: "pointer",
                  }}
                >
                  {SORT_LABELS[sort]} ✕
                </button>
              )}
              <div style={{ marginLeft: "auto" }}>
                <Link
                  href={`/search/multi?q=${encodeURIComponent(initialQ)}&game=${game}`}
                  style={{
                    fontFamily: "var(--font-display)", fontWeight: 700, fontStretch: "112%",
                    fontSize: "9px", letterSpacing: "0.14em", textTransform: "uppercase",
                    color: "var(--color-dojo-gold)", textDecoration: "none",
                  }}
                >
                  Multi-select ›
                </Link>
              </div>
            </div>

            {/* F-06: Filter by set. Options are the sets present in the
                (unfiltered) results, plus an "All sets" clear option.
                Selecting one drives the ?set= URL param, which the search
                query above reacts to. */}
            {/* F-06 filters: set, rarity, graded/ungraded, price range.
                Each is URL-driven (via applyFilters), so the search query
                above reacts and the state survives refresh / deep-links. */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", marginBottom: "10px" }}>
              {setOptions.length > 0 && (
                <div className="dojo-input-wrap" style={{ flex: "1 1 140px", minWidth: 0 }}>
                  <label className="dojo-label" htmlFor="set-filter">Filter by set</label>
                  <select
                    id="set-filter"
                    data-testid="set-filter"
                    aria-label="Filter by set"
                    className="dojo-select"
                    value={setFilter}
                    onChange={(e) => applySetFilter(e.target.value)}
                  >
                    <option value="">All sets</option>
                    {setOptions.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              )}

              {rarityOptions.length > 0 && (
                <div className="dojo-input-wrap" style={{ flex: "1 1 140px", minWidth: 0 }}>
                  <label className="dojo-label" htmlFor="rarity-filter">Rarity</label>
                  <select
                    id="rarity-filter"
                    data-testid="rarity-filter"
                    aria-label="Filter by rarity"
                    className="dojo-select"
                    value={rarityFilter}
                    onChange={(e) => applyFilters({ rarity: e.target.value })}
                  >
                    <option value="">All rarities</option>
                    {rarityOptions.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="dojo-input-wrap" style={{ flex: "1 1 140px", minWidth: 0 }}>
                <label className="dojo-label" htmlFor="graded-filter">Graded</label>
                <select
                  id="graded-filter"
                  data-testid="graded-filter"
                  aria-label="Filter by graded"
                  className="dojo-select"
                  value={gradedFilter}
                  onChange={(e) => applyFilters({ graded: e.target.value })}
                >
                  <option value="">Both</option>
                  <option value="graded">Graded only</option>
                  <option value="ungraded">Ungraded only</option>
                </select>
              </div>

              <div className="dojo-input-wrap" style={{ flex: "1 1 200px", minWidth: 0 }}>
                <label className="dojo-label">Price range (USD)</label>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    placeholder="Min"
                    aria-label="Minimum price"
                    data-testid="min-price-filter"
                    className="dojo-input"
                    defaultValue={minPriceFilter}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== minPriceFilter) applyFilters({ minPrice: v });
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    style={{ minWidth: 0 }}
                  />
                  <span style={{ color: "var(--color-dojo-faint)", fontSize: "12px" }}>–</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    placeholder="Max"
                    aria-label="Maximum price"
                    data-testid="max-price-filter"
                    className="dojo-input"
                    defaultValue={maxPriceFilter}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== maxPriceFilter) applyFilters({ maxPrice: v });
                    }}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    style={{ minWidth: 0 }}
                  />
                </div>
              </div>
            </div>

            {/* Card grid — adaptive columns (2 mobile / 3 tablet / 4–5 desktop) */}
            <div className="dojo-card-grid">
              {isFetching
                ? Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)
                : isError
                ? (
                  <div style={{ gridColumn: "1/-1", textAlign: "center", padding: "40px 0", color: "var(--color-dojo-body)" }}>
                    <p style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13px" }}>
                      Could not load results. Check your connection and try again.
                    </p>
                  </div>
                )
                : cards.length === 0
                ? (
                  <div style={{ gridColumn: "1/-1", textAlign: "center", padding: "40px 0", color: "var(--color-dojo-body)" }}>
                    <p style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13px" }}>
                      No cards found for &ldquo;{initialQ}&rdquo;
                    </p>
                  </div>
                )
                : cards.map((card, i) => (
                    <CardTile
                      key={card.id}
                      card={card}
                      index={i}
                      game={game}
                      onAdd={setAddSheetCard}
                      tracked={isWanted(card.id)}
                      onToggleTrack={() => {
                        const next = toggleWant({
                          externalId: card.id,
                          name: card.name,
                        });
                        setAddToast(next ? "Added to Want to Buy" : "Removed from Want to Buy");
                      }}
                      // Tile click navigates straight to the card detail page.
                      onOpen={() =>
                        goToCard({
                          id: card.id,
                          name: card.name,
                          setName: card.setImage ?? card.setName ?? card.set ?? undefined,
                          imageUrl: card.imageUrl ?? card.image ?? undefined,
                          marketPrice: card.marketPrice ?? card.price ?? null,
                          rarity: card.rarity ?? undefined,
                        })
                      }
                    />
                  ))}
            </div>

            {/* Pull-up hint */}
            {!isFetching && cards.length > 0 && (
              <div style={{ marginTop: "24px", display: "flex", justifyContent: "center" }}>
                <span
                  style={{
                    fontFamily: "var(--font-display)", fontWeight: 700, fontStretch: "112%",
                    fontSize: "9px", letterSpacing: "0.18em", textTransform: "uppercase",
                    color: "var(--color-dojo-faint)",
                  }}
                >
                  Pull up for more
                </span>
              </div>
            )}
          </>
        )}
      </div>

      {/* Client feedback: + on a card opens this bottom sheet to pick
          Ungraded / Graded before adding. */}
      {addSheetCard && (
        <AddCardSheet
          card={addSheetCard}
          initialCondition={addSheetCard.rarity ?? undefined}
          onClose={() => setAddSheetCard(null)}
          onAdded={(msg) => {
            setAddSheetCard(null);
            setAddToast(msg);
          }}
        />
      )}

      {/* Lightweight toast for confirmations + coming-soon flags */}
      {addToast && (
        <Toast message={addToast} onDismiss={() => setAddToast(null)} />
      )}

      {/* Filter / sort bottom sheet — opened by the funnel icon in the
          search bar. Ships sort options; price-range + set-dropdown
          filters are deliberately deferred (need extra UI + API surface
          for marginal wins). */}
      {filterOpen && (
        <FilterSheet
          currentSort={sort}
          onSelect={(next) => {
            setSort(next);
            setFilterOpen(false);
          }}
          onClose={() => setFilterOpen(false)}
        />
      )}
    </div>
  );
}

// ── Add-Card bottom sheet (Ungraded / Graded picker) ──────────────
// Client feedback: tapping + on a card must open a bottom sheet with
// card-type options, not silently toggle a batch-selection state.
// Ungraded adds directly via POST /api/users/me/collection. Graded is
// UI-only for MVP (see Phase 4 in the plan).
// Options for the graded form dropdowns (Phase 3.4). UI-only; real
// grading integration is a Week 3 backend feature (schema change to
// UserCollection + grader-specific fee/turnaround data).
// Grading companies parseGraded() recognises in an incoming condition
// string (the Add sheet UI itself only offers RAW / PSA per the design).
const GRADERS = ["PSA", "BGS", "CGC", "SGC"] as const;
// Raw (ungraded) condition options: value persisted on the row (short code),
// label shown to the user (full name per the design).
const RAW_CONDITIONS: { label: string; value: string }[] = [
  { label: "Near mint", value: "NM" },
  { label: "Lightly played", value: "LP" },
  { label: "Moderately played", value: "MP" },
  { label: "Heavily played", value: "HP" },
  { label: "Damaged", value: "DMG" },
];
// PSA numeric-grade options: label shown, value carries the numeric grade
// so `resolveCondition()` persists "PSA <grade>".
const PSA_CONDITIONS: { label: string; value: string }[] = [
  { label: "Gem Mint 10", value: "Grade 10" },
  { label: "Mint 9", value: "Grade 9" },
  { label: "NM-MT 8", value: "Grade 8" },
  { label: "EX-MT 6", value: "Grade 6" },
  { label: "EX 5", value: "Grade 5" },
  { label: "VG-EX 4", value: "Grade 4" },
  { label: "VG 3", value: "Grade 3" },
  { label: "Good 2", value: "Grade 2" },
  { label: "Fair 1.5", value: "Grade 1.5" },
  { label: "Poor 1", value: "Grade 1" },
];

/** Parse a graded condition string like "PSA 10" / "BGS 9.5" into its
 *  grading company + grade. Returns null when the string names no known
 *  company (i.e. the card is raw/ungraded), which is how the Add sheet
 *  decides whether to open the graded form. */
function parseGraded(
  condition: string | undefined | null
): { grader: (typeof GRADERS)[number]; grade: string } | null {
  if (!condition) return null;
  const grader = GRADERS.find((g) => new RegExp(`\\b${g}\\b`, "i").test(condition));
  if (!grader) return null;
  const grade = condition.match(/\d+(?:\.\d+)?/)?.[0] ?? "";
  return { grader, grade };
}

// Custom listbox (no native <select>) — dark box + chevron trigger that
// opens a dark panel of full-name rows with thin dividers. Reuses the
// .dojo-select-trigger/.dojo-menu styling already in globals.css; rows use
// a dark-gray hover/selected highlight (no browser blue). Closes on outside
// click or Escape.
function DojoSelect({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder,
  testId,
}: {
  value: string;
  options: { label: string; value: string }[];
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        data-testid={testId}
        className={`dojo-select-trigger${open ? " open" : ""}`}
        style={{ width: "100%" }}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`val${selected ? "" : " ph"}`}>{selected?.label ?? placeholder ?? "Select"}</span>
        <span className="chev" aria-hidden="true">
          <svg width="12" height="7" viewBox="0 0 12 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square">
            <path d="M1 1l5 5 5-5" />
          </svg>
        </span>
      </button>
      {open && (
        <>
          {/* Outside-click scrim closes the panel. */}
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 59 }} />
          <div role="listbox" aria-label={ariaLabel} className="dojo-menu" style={{ top: "100%", marginTop: "4px", zIndex: 60 }}>
            {options.map((o) => {
              const on = o.value === value;
              return (
                <div
                  key={o.value}
                  role="option"
                  aria-selected={on}
                  className="row"
                  // Dark-gray highlight for selected/hover (no gold tint, no
                  // browser blue). Hover handled via inline pointer events so
                  // we don't need a new CSS class.
                  style={{ background: on ? "var(--color-dojo-raised-2, #2a2a2a)" : "transparent" }}
                  onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = "var(--color-dojo-raised-2, #2a2a2a)"; }}
                  onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = "transparent"; }}
                  onClick={() => { onChange(o.value); setOpen(false); }}
                >
                  <span style={{ flex: 1 }}>{o.label}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function AddCardSheet({
  card,
  onClose,
  onAdded,
  initialCondition,
}: {
  card: TrendingCard | CardResult;
  onClose: () => void;
  onAdded: (message: string) => void;
  /** Card's grade/condition string (e.g. "PSA 10"). When it names a
   *  grading company the sheet opens straight into the graded form,
   *  pre-filled — this is the F-19 Graded Add Flow entry point. */
  initialCondition?: string;
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Parse "PSA 10" → { grader: "PSA", grade: "10" } so a graded card
  // pre-fills its grader + condition.
  const parsed = parseGraded(initialCondition);

  // GRADER: only RAW and PSA per the design. A graded card (initialCondition
  // names a company) opens on PSA; everything else defaults to RAW.
  const [grader, setGrader] = useState<"RAW" | "PSA">(parsed ? "PSA" : "RAW");
  // CONDITION: the select value. For RAW it's a raw grade (NM…DMG); for PSA
  // it's a "Gem Mint 10"-style option whose numeric grade we persist.
  const [condition, setCondition] = useState<string>(
    parsed ? `Grade ${parsed.grade}` : RAW_CONDITIONS[0].value
  );
  const [collectionId, setCollectionId] = useState<string>("");
  const [qty, setQty] = useState(1);
  const [showPayment, setShowPayment] = useState(false);
  const [pricePaid, setPricePaid] = useState("");

  // The user's named collections for the COLLECTION dropdown.
  const { data: collections = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["collections"],
    queryFn: async () => {
      const res = await fetch("/api/collections", { credentials: "include" });
      if (!res.ok) return [];
      return (await res.json()).data ?? [];
    },
  });

  // `id` is the internal DB id for TrendingCard, but the *search* API
  // returns `id` as the externalId. Use externalId when available.
  const externalId = "externalId" in card ? card.externalId : card.id;
  const marketPrice = "marketPrice" in card ? (card.marketPrice ?? card.price ?? null) : (card.price ?? null);
  const imgSrc = (card as { imageUrl?: string }).imageUrl;
  const setLabel = (card as { setImage?: string; setName?: string }).setImage
    ?? (card as { setName?: string }).setName ?? "";
  const showSet = setLabel && setLabel.toLowerCase() !== "unknown set";

  // Condition options depend on the grader (Task 2 §5).
  const conditionOptions = grader === "PSA" ? PSA_CONDITIONS : RAW_CONDITIONS;

  // Keep the selected condition valid when the grader flips.
  const onGraderChange = (g: "RAW" | "PSA") => {
    setGrader(g);
    setCondition(g === "PSA" ? PSA_CONDITIONS[0].value : RAW_CONDITIONS[0].value);
  };

  /** The `condition` string persisted on the collection row:
   *  PSA → "PSA <grade>" (e.g. "PSA 10"); RAW → the raw grade (e.g. "NM"). */
  function resolveCondition(): string {
    if (grader === "PSA") {
      const grade = condition.match(/\d+(?:\.\d+)?/)?.[0] ?? "10";
      return `PSA ${grade}`;
    }
    return condition;
  }

  async function handleAdd() {
    setAdding(true);
    setErrMsg(null);
    try {
      const cardPayload: Record<string, unknown> = {
        externalId,
        name: card.name,
        setName: (card as { setName?: string; setImage?: string }).setName
          ?? (card as { setImage?: string }).setImage ?? undefined,
        marketPrice,
        quantity: qty,
        isFoil: false,
        condition: resolveCondition(),
      };
      if (collectionId) cardPayload.collectionId = collectionId;
      const paid = Number.parseFloat(pricePaid);
      if (showPayment && Number.isFinite(paid) && paid > 0) cardPayload.purchasePrice = paid;
      if (imgSrc && typeof imgSrc === "string" && imgSrc.trim().length > 0) {
        cardPayload.imageUrl = imgSrc;
      }

      const res = await fetch("/api/users/me/collection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cards: [cardPayload] }),
      });
      const json = await res.json();
      if (!res.ok || json.added === 0) {
        throw new Error(json?.message ?? "Could not add this card.");
      }
      queryClient.invalidateQueries({ queryKey: ["collection"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio-collection"] });
      onAdded(`Added ${card.name} to your portfolio`);
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : "Something went wrong.");
      setAdding(false);
    }
  }

  const label: React.CSSProperties = { fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "9px", letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--color-dojo-faint)" };

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={adding ? undefined : onClose}
        style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(0,0,0,0.6)", animation: "dojo-fade-in 180ms ease-out both" }}
      />
      {/* Bottom sheet */}
      <div
        role="dialog"
        aria-label="Add card to portfolio"
        data-testid="graded-add-modal"
        style={{
          position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 91,
          background: "var(--color-dojo-card)",
          borderTop: "1px solid var(--color-dojo-stroke)",
          padding: "10px 22px 26px",
          paddingBottom: "calc(26px + env(safe-area-inset-bottom, 0px))",
          maxHeight: "90vh", overflowY: "auto",
          animation: "dojo-slide-up 220ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
        }}
      >
        {/* Drag handle */}
        <div aria-hidden="true" style={{ width: "40px", height: "4px", borderRadius: "2px", background: "var(--color-dojo-stroke)", margin: "0 auto 14px" }} />

        {/* Header row */}
        <div style={{ display: "flex", alignItems: "center", marginBottom: "16px" }}>
          <span style={label}>Add Card</span>
          <button
            onClick={onClose}
            disabled={adding}
            aria-label="Close"
            style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--color-dojo-body)", cursor: "pointer", display: "flex", padding: 0, opacity: adding ? 0.4 : 1 }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
              <line x1="3" y1="3" x2="15" y2="15" />
              <line x1="15" y1="3" x2="3" y2="15" />
            </svg>
          </button>
        </div>

        {/* Card summary row */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: "12px", marginBottom: "18px" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="dojo-heading" style={{ fontSize: "18px", lineHeight: 1.2 }}>{card.name}</div>
            {showSet && (
              <div style={{ marginTop: "4px", fontSize: "11.5px", color: "var(--color-dojo-body)" }}>
                {setLabel}{grader === "PSA" ? ` · ${resolveCondition()}` : " · Raw"}
              </div>
            )}
            <div style={{ marginTop: "8px", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "22px", fontVariantNumeric: "tabular-nums", color: marketPrice != null ? "var(--color-dojo-gold)" : "var(--color-dojo-faint)" }}>
              {marketPrice != null ? fmtUSD(marketPrice) : "—"}
            </div>
          </div>
          {imgSrc && (
            <div style={{ flex: "none", width: "62px" }}>
              <CardImage src={imgSrc} alt={card.name} initials={cardInitials(card.name)} initialsSize="14px" style={{ background: "var(--color-dojo-raised)", border: "none" }} />
            </div>
          )}
        </div>

        {errMsg && (
          <div style={{ background: "var(--color-dojo-app)", border: "1px solid var(--color-dojo-vermilion)", padding: "10px 12px", marginBottom: "16px" }}>
            <p className="dojo-error" style={{ margin: 0, fontSize: "12px" }}>{errMsg}</p>
          </div>
        )}

        {/* GRADER — RAW / PSA segmented pills */}
        <div style={{ ...label, marginBottom: "8px" }}>Grader</div>
        <div role="radiogroup" aria-label="Grading Company" style={{ display: "flex", border: "1px solid var(--color-dojo-stroke)", marginBottom: "18px" }}>
          {(["RAW", "PSA"] as const).map((g) => {
            const on = grader === g;
            return (
              <button
                key={g}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onGraderChange(g)}
                style={{
                  flex: 1, padding: "11px 0", cursor: "pointer", border: "none",
                  background: on ? "var(--color-dojo-gold)" : "var(--color-dojo-card)",
                  color: on ? "var(--color-dojo-app)" : "var(--color-dojo-faint)",
                  fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px", letterSpacing: "0.14em",
                }}
              >
                {g}
              </button>
            );
          })}
        </div>

        {/* CONDITION — custom listbox (no native <select>). Options depend
            on the grader. */}
        <div style={{ ...label, marginBottom: "8px" }}>Condition</div>
        <div style={{ marginBottom: "18px" }}>
          <DojoSelect
            ariaLabel="Condition"
            testId="condition-select"
            placeholder="Select condition"
            value={condition}
            options={conditionOptions}
            onChange={setCondition}
          />
        </div>

        {/* COLLECTION + QTY row */}
        <div style={{ display: "flex", gap: "12px", marginBottom: "18px" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ ...label, marginBottom: "8px" }}>Collection</div>
            <DojoSelect
              ariaLabel="Collection"
              testId="collection-select"
              value={collectionId}
              options={[{ label: "Main", value: "" }, ...collections.map((c) => ({ label: c.name, value: c.id }))]}
              onChange={setCollectionId}
            />
          </div>
          <div style={{ flex: "none" }}>
            <div style={{ ...label, marginBottom: "8px" }}>Qty</div>
            <div style={{ display: "flex", alignItems: "center", border: "1px solid var(--color-dojo-stroke)" }}>
              <button type="button" aria-label="Decrease quantity" onClick={() => setQty((q) => Math.max(1, q - 1))}
                style={{ width: "34px", height: "38px", border: "none", background: "transparent", color: "var(--color-dojo-ink)", cursor: "pointer", fontSize: "16px" }}>−</button>
              <div style={{ width: "34px", textAlign: "center", fontFamily: "var(--font-display)", fontWeight: 700, fontVariantNumeric: "tabular-nums", fontSize: "14px", color: "var(--color-dojo-ink)" }}>{qty}</div>
              <button type="button" aria-label="Increase quantity" onClick={() => setQty((q) => q + 1)}
                style={{ width: "34px", height: "38px", border: "none", background: "transparent", color: "var(--color-dojo-ink)", cursor: "pointer", fontSize: "16px" }}>+</button>
            </div>
          </div>
        </div>

        {/* RECORD PAYMENT (optional) */}
        <div style={{ display: "flex", alignItems: "center", marginBottom: showPayment ? "8px" : "20px" }}>
          <span style={label}>Record Payment</span>
          <span style={{ marginLeft: "6px", fontSize: "9px", color: "var(--color-dojo-faint)", textTransform: "lowercase", letterSpacing: 0 }}>optional</span>
          {!showPayment && (
            <button type="button" onClick={() => setShowPayment(true)}
              style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-gold)" }}>
              + Add
            </button>
          )}
        </div>
        {showPayment && (
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            placeholder="Price paid (USD)"
            aria-label="Price paid"
            value={pricePaid}
            onChange={(e) => setPricePaid(e.target.value)}
            className="dojo-input"
            style={{ width: "100%", marginBottom: "20px" }}
          />
        )}

        {/* ADD TO PORTFOLIO */}
        <button
          type="button"
          onClick={handleAdd}
          disabled={adding}
          className="dojo-btn dojo-btn-primary"
          style={{ width: "100%" }}
        >
          {adding ? "ADDING…" : "ADD TO PORTFOLIO"}
        </button>
      </div>
    </>
  );
}

// Toast is now sourced from src/components/Toast.tsx (shared with auth
// pages) so the styling and behaviour stay in sync everywhere.

// ── Default export with Suspense boundary ─────────────────────────
export default function SearchPage() {
  return (
    <Suspense fallback={
      <div style={{ padding: "12px 22px" }}>
        <div style={{ height: "48px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)" }} />
      </div>
    }>
      <SearchPageInner />
    </Suspense>
  );
}
