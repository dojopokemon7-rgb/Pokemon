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
 *   (prisma/seed.ts — ~70+ real Pokémon/One Piece cards) with keyset
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

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useState, useRef, Suspense } from "react";
import { setPendingCollectionCards } from "@/lib/utils/pending-collection";

// ── Types ──────────────────────────────────────────────────────────
interface CardResult {
  id: string;
  name: string;
  set?: string;
  setName?: string;
  imageUrl?: string;
  image?: string;
  marketPrice?: number;
  price?: number;
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
}

interface TrendingApiResponse {
  cards: TrendingCard[];
  nextCursor: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────
type Game = "pokemon" | "onepiece";

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
  tracked,
  onToggleTrack,
  selected,
  onToggleSelect,
}: {
  card: TrendingCard;
  tracked: boolean;
  onToggleTrack: () => void;
  selected: boolean;
  onToggleSelect: () => void;
}) {
  const initials = getInitials(card.name);

  return (
    <div
      style={{
        position: "relative",
        background: "var(--color-dojo-card)",
        border: "1px solid var(--color-dojo-stroke)",
        padding: "13px",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Star — track this card */}
      <button
        onClick={onToggleTrack}
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
          color: tracked ? "#0D0D0D" : "var(--color-dojo-body)",
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

      {card.imageUrl ? (
        <img
          src={card.imageUrl}
          alt={card.name}
          loading="lazy"
          style={{ width: "62%", alignSelf: "center", aspectRatio: "660 / 921", objectFit: "cover", background: "var(--color-dojo-raised)" }}
        />
      ) : (
        <div
          style={{
            width: "62%",
            alignSelf: "center",
            aspectRatio: "660 / 921",
            background: "var(--color-dojo-raised)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "22px", letterSpacing: "0.04em", color: "var(--color-dojo-gold)" }}>
            {initials}
          </span>
        </div>
      )}

      <div style={{ marginTop: "12px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "14.5px", lineHeight: 1.3, color: "var(--color-dojo-ink)" }}>
        {card.name}
      </div>
      <div style={{ marginTop: "4px", fontSize: "11.5px", lineHeight: 1.45, color: "var(--color-dojo-body)" }}>
        {card.setImage || "Unknown set"}
      </div>

      <div style={{ marginTop: "12px", display: "flex", alignItems: "flex-end", gap: "8px" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "3px" }}>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontVariantNumeric: "tabular-nums", fontSize: "15px", color: card.price != null ? "var(--color-dojo-ink)" : "var(--color-dojo-faint)" }}>
            {card.price != null ? fmtUSD(card.price) : "—"}
          </div>
          {card.delta != null && (
            <div
              style={{
                fontFamily: "var(--font-display)",
                fontWeight: 400,
                fontVariantNumeric: "tabular-nums",
                fontSize: "11px",
                color: card.up ? "#00A86B" : "var(--color-dojo-vermilion)",
              }}
            >
              {card.up ? "▲" : "▼"} {card.delta}
            </div>
          )}
        </div>
        {/* Plus — add to selection */}
        <button
          onClick={onToggleSelect}
          aria-pressed={selected}
          title="Add to collection"
          style={{
            flex: "none",
            width: "34px",
            height: "34px",
            borderRadius: "50%",
            border: "1.5px solid " + (selected ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"),
            background: selected ? "var(--color-dojo-gold)" : "var(--color-dojo-card)",
            color: selected ? "#0D0D0D" : "var(--color-dojo-body)",
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
    </div>
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
      <div style={{ aspectRatio: "3/4", background: "var(--color-dojo-raised)", animation: "dojo-pulse 1.5s ease-in-out infinite" }} />
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
function CardTile({ card, index = 0 }: { card: CardResult; index?: number }) {
  const imgSrc = card.imageUrl ?? card.image;
  const price = card.marketPrice ?? card.price ?? 0;
  const setName = card.setName ?? card.set ?? "";
  const initials = getInitials(card.name);

  // There is no GET-by-id card API (only /api/cards/search), so the
  // card's own search-result fields are carried forward via query
  // params to the detail page rather than re-fetched. This mirrors the
  // reference's approach in spirit — SCREENS.card reads from a single
  // in-memory CARD object already available to the whole app, not a
  // fresh network fetch per card.
  const detailParams = new URLSearchParams({
    name: card.name,
    ...(setName ? { set: setName } : {}),
    ...(imgSrc ? { img: imgSrc } : {}),
    ...(price ? { price: String(price) } : {}),
  });

  return (
    <Link
      href={`/search/${card.id}?${detailParams.toString()}`}
      style={{
        background: "var(--color-dojo-card)",
        border: "1px solid var(--color-dojo-stroke)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        textDecoration: "none",
        cursor: "pointer",
        animation: "dojo-fade-up 260ms ease-out both",
        animationDelay: `${Math.min(index, 12) * 35}ms`,
      }}
    >
      {/* Card image or initials fallback */}
      <div
        style={{
          aspectRatio: "3/4",
          background: "var(--color-dojo-raised)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {imgSrc ? (
          <img
            src={imgSrc}
            alt={card.name}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
            loading="lazy"
          />
        ) : (
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 800,
              fontSize: "26px",
              letterSpacing: "0.04em",
              color: "var(--color-dojo-gold)",
            }}
          >
            {initials}
          </span>
        )}
        {/* Add button overlay */}
        <div
          style={{
            position: "absolute",
            top: "8px",
            right: "8px",
            width: "24px",
            height: "24px",
            border: "1px solid var(--color-dojo-stroke)",
            background: "var(--color-dojo-card)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--color-dojo-body)",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <line x1="6" y1="1" x2="6" y2="11" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" />
            <line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" />
          </svg>
        </div>
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
        {setName && (
          <div style={{ marginTop: "-2px", fontSize: "11px", color: "var(--color-dojo-body)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
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
        </div>
      </div>
    </Link>
  );
}

// ── Search bar ─────────────────────────────────────────────────────
function SearchBar({ defaultValue, onSearch, onClear }: {
  defaultValue?: string;
  onSearch: (q: string) => void;
  onClear?: () => void;
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onSearch(value.trim());
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
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="charizard"
        autoFocus={!defaultValue}
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
      {value && (
        <button
          type="button"
          onClick={() => { setValue(""); onClear?.(); inputRef.current?.focus(); }}
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-dojo-body)", display: "flex", alignItems: "center", padding: 0 }}
          aria-label="Clear search"
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
            <line x1="2" y1="2" x2="13" y2="13" />
            <line x1="13" y1="2" x2="2" y2="13" />
          </svg>
        </button>
      )}
    </form>
  );
}

// ── Inner page (reads searchParams) ───────────────────────────────
function SearchPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialQ = searchParams.get("q") ?? "";
  const hasQuery = initialQ.trim().length > 0;
  const [game, setGame] = useState<Game>("pokemon");

  // "Track this card" (star) and "add to selection" (plus) state for
  // the Trending grid — ported from S.wish / S.sel in the reference.
  const [tracked, setTracked] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleTracked = (id: string) => {
    setTracked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
    queryKey: ["trending-cards"],
    queryFn: async ({ pageParam }) => {
      const cursorParam = pageParam ? `&cursor=${encodeURIComponent(String(pageParam))}` : "";
      const res = await fetch(`/api/cards/trending?limit=10${cursorParam}`);
      if (!res.ok) throw new Error("Failed to load trending cards");
      return res.json();
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !hasQuery,
  });

  const trendingCards = trendingPages?.pages.flatMap((p) => p.cards) ?? [];

  const { data, isFetching, isError } = useQuery<SearchApiResponse>({
    queryKey: ["card-search", game, initialQ],
    queryFn: async () => {
      const res = await fetch(
        `/api/cards/search?game=${game}&query=${encodeURIComponent(initialQ)}`
      );
      if (!res.ok) {
        if (res.status === 404) return { cards: [] };
        throw new Error("Search failed");
      }
      return res.json();
    },
    enabled: initialQ.trim().length > 0,
  });

  const cards = data?.cards ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {/* ── Sticky search bar ── */}
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
        <SearchBar defaultValue={initialQ} onSearch={doSearch} onClear={clearSearch} />

        {/* Game tabs — only shown when there's a query */}
        {hasQuery && (
          <div style={{ display: "flex", gap: "0", marginTop: "10px" }}>
            {(["pokemon", "onepiece"] as Game[]).map((g) => (
              <button
                key={g}
                onClick={() => {
                  setGame(g);
                  router.replace(`/search?q=${encodeURIComponent(initialQ)}&game=${g}`);
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
        )}
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
              <span
                style={{
                  marginLeft: "auto",
                  fontFamily: "var(--font-display)", fontWeight: 700, fontStretch: "112%",
                  fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase",
                  color: "var(--color-dojo-faint)",
                }}
              >
                Tap + to add
              </span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px", marginTop: "12px" }}>
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
                    tracked={tracked.has(card.id)}
                    onToggleTrack={() => toggleTracked(card.id)}
                    selected={selected.has(card.id)}
                    onToggleSelect={() => toggleSelected(card.id)}
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

            {/* CONTINUE / Skip footer — ported from searchEmpty()'s
                !S.onboarded branch. CONTINUE shows the selected count
                once any card is picked via the plus button. */}
            <div style={{ display: "flex", flexDirection: "column", gap: "14px", padding: "18px 0 4px" }}>
              <button
                onClick={() => {
                  if (selected.size === 0) {
                    router.push("/dashboard");
                    return;
                  }
                  const cardsToAdd = trendingCards
                    .filter((c) => selected.has(c.id))
                    .map((c) => ({
                      externalId: c.externalId,
                      name: c.name,
                      setName: c.setImage || undefined,
                      imageUrl: c.imageUrl ?? undefined,
                      marketPrice: c.price,
                      quantity: 1,
                      isFoil: false,
                    }));
                  
                  if (cardsToAdd.length === 0) {
                    return;
                  }
                  
                  setPendingCollectionCards(cardsToAdd);
                  router.push("/collection/add");
                }}
                className="dojo-btn dojo-btn-primary"
              >
                {selected.size > 0 ? `CONTINUE (${selected.size})` : "CONTINUE"}
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

            {/* Card grid */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, 1fr)",
                gap: "10px",
              }}
            >
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
                : cards.map((card, i) => <CardTile key={card.id} card={card} index={i} />)}
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
    </div>
  );
}

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
