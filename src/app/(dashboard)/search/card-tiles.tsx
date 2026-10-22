"use client";

/**
 * Search tile components — extracted from the search page.tsx.
 *
 * A Next.js App Router `page.tsx` may export ONLY its default component;
 * any named export fails `next build` ("… is not a valid Page export
 * field"), even though `tsc --noEmit` does not flag it. These two
 * presentational tiles were previously exported (named) from page.tsx
 * purely so the unit test could import them — that broke the production
 * build. They live here instead (a plain client module, named exports
 * allowed), and page.tsx imports them. The implementation is IDENTICAL —
 * same real weeklyChangePct delta rendering, same design tokens, square
 * corners (AGENTS.md rules 2 + 10 + 14).
 */

import Link from "next/link";
import { CardImage, cardInitials, NoPriceText } from "@/components/CardImage";
import { onePieceImageChain } from "@/lib/utils/card-image";
import { fmtWeeklyDelta } from "@/lib/utils/weekly-delta";

// ── Types ──────────────────────────────────────────────────────────
// Matches NormalizedCardSchema on the server (card.validator.ts).
// The set NAME is carried in `setImage` despite the name — historical
// artefact from when the field held a URL. The `set` / `setName`
// aliases are kept for older callers that pre-dated this file.
export interface CardResult {
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
  // REAL 7-day change (Scrydex trends.days_7), threaded straight through from
  // the search API's NormalizedCard. Nullable — the tile shows a movement
  // indicator ONLY when this is a real number, never a fabricated delta.
  weeklyChangePct?: number | null;
}

// ── Trending card shape — matches /api/cards/trending's response.
// `price`/`delta`/`up` are nullable: `delta`/`up` carry the REAL stored
// 7-day change (Card.weeklyChangePct), null when a card has no recorded
// change — the API NEVER fabricates one (see route.ts for the rationale). ─
export interface TrendingCard {
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

export type Game = "pokemon" | "onepiece";

function fmtUSD(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

// ── Trend card tile — ported from trendCard() in app.js. Star toggles
// "track this card" (top-right), plus toggles selection for the
// CONTINUE/ADD TO COLLECTION flow (bottom-right of the price row). ──
// Exported (named) so the tile's delta rendering can be unit-tested directly
// (tests/unit/search-tile-delta.test.tsx). This is a COMPONENT export, not a
// helper — extracted helpers still live in src/lib (e.g. fmtWeeklyDelta).
export function TrendCardTile({
  card,
  game,
  tracked,
  onToggleTrack,
  selected,
  onToggleSelect,
  onOpen,
  onPrefetch,
}: {
  card: TrendingCard;
  game: Game;
  tracked: boolean;
  onToggleTrack: () => void;
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  /** Fired once on first hover/focus/touch intent (Batch 2B · Item 1). */
  onPrefetch: () => void;
}) {
  const initials = cardInitials(card.name);

  // Item 1: the tile is now a next/link <Link> (route prefetch for free +
  // middle-click / open-in-new-tab). The href points to the detail page
  // built from the SAME params goToCard threads (there is no get-by-id
  // API). The plain click is intercepted so goToCard still threads
  // price/image/number/rarity — mirrors CardTile's established pattern.
  // NOTE: the raw image url is NOT threaded as `img=` (it would leak the
  // upstream `images.scrydex.com` host in the address bar). The detail page
  // rebuilds the hero from the route id via /api/card-img/<id> instead.
  const detailParams = new URLSearchParams({ name: card.name, game });
  if (card.setImage) detailParams.set("set", card.setImage);
  if (card.price != null) detailParams.set("price", String(card.price));
  if (card.rarity) detailParams.set("rarity", card.rarity);

  return (
    <Link
      href={`/search/${encodeURIComponent(card.externalId)}?${detailParams.toString()}`}
      className="dojo-card-tile"
      data-testid="card-result"
      // Warm the detail queries on first intent — hover (desktop), focus
      // (keyboard), and touchstart (mobile) all count as "about to open".
      onMouseEnter={onPrefetch}
      onFocus={onPrefetch}
      onTouchStart={onPrefetch}
      onClick={(e) => {
        e.preventDefault();
        onOpen();
      }}
      style={{
        position: "relative",
        background: "var(--color-dojo-card)",
        border: "1px solid var(--color-dojo-stroke)",
        padding: "13px",
        display: "flex",
        flexDirection: "column",
        cursor: "pointer",
        textDecoration: "none",
      }}
    >
      {/* Star — track this card. preventDefault stops the enclosing
          <Link> navigating when the control is tapped. */}
      <button
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

      {/* Card art — CardImage handles missing/broken src fallbacks to initials.
          For One Piece, pass the image fallback chain so a 404/blocked source
          auto-advances to the next tier (clean → CDN → Bandai proxy). */}
      <div style={{ width: "100%" }}>
        <CardImage
          src={card.imageUrl}
          cardId={game === "onepiece" ? undefined : card.externalId}
          fallbackChain={
            game === "onepiece"
              ? onePieceImageChain(card.externalId, card.imageUrl)
              : undefined
          }
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
            {card.price != null ? fmtUSD(card.price) : <NoPriceText fontSize="11px" />}
          </div>
          {/* REAL value deviation (Scrydex 7-day change). The trending route
              formats the stored Card.weeklyChangePct into `delta`/`up`; a card
              with no recorded change sends `delta:null, up:null`. Render the
              movement indicator ONLY when both are present — never a
              fabricated delta (AGENTS.md rule 2). */}
          {card.delta != null && card.up != null && (
            <div
              style={{
                fontFamily: "var(--font-display)",
                fontWeight: 400,
                fontVariantNumeric: "tabular-nums",
                fontSize: "11px",
                color: card.up ? "var(--color-dojo-jade)" : "var(--color-dojo-vermilion)",
              }}
            >
              {card.up ? "▲" : "▼"} {card.delta}
            </div>
          )}
        </div>
        {/* Plus — add to selection. preventDefault stops the enclosing
            <Link> navigating when the control is tapped. */}
        <button
          onClick={(e) => {
            e.preventDefault();
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
    </Link>
  );
}

// ── Card Grid Tile ─────────────────────────────────────────────────
// Fades/slides up on mount, staggered by grid position. The reference
// prototype's grid never animates (searchResults() inserts static
// markup) — this is a new addition, documented in ANIMATION_SPECS.md.
// Exported (named) so the tile's delta rendering can be unit-tested directly
// (tests/unit/search-tile-delta.test.tsx). COMPONENT export, not a helper.
export function CardTile({
  card,
  index = 0,
  game,
  onAdd,
  tracked,
  onToggleTrack,
  onOpen,
  onPrefetch,
}: {
  card: CardResult;
  index?: number;
  game: Game;
  onAdd: (card: CardResult) => void;
  tracked: boolean;
  onToggleTrack: () => void;
  onOpen: () => void;
  /** Fired once on first hover/focus/touch intent (Batch 2B · Item 1). */
  onPrefetch: () => void;
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
  // NOTE: the raw image url is NOT threaded as `img=` (it would leak the
  // upstream `images.scrydex.com` host in the address bar). The detail page
  // rebuilds the hero from the route id via /api/card-img/<id> instead.
  const detailParams = new URLSearchParams({
    name: card.name,
    game,
    ...(setName ? { set: setName } : {}),
    ...(price ? { price: String(price) } : {}),
    ...(card.number ? { number: card.number } : {}),
    ...(card.rarity ? { rarity: card.rarity } : {}),
  });

  return (
    <Link
      href={`/search/${card.id}?${detailParams.toString()}`}
      className="dojo-card-tile"
      data-testid="card-result"
      // Warm the detail queries on first intent (Batch 2B · Item 1).
      onMouseEnter={onPrefetch}
      onFocus={onPrefetch}
      onTouchStart={onPrefetch}
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
          cardId={game === "onepiece" ? undefined : card.id}
          fallbackChain={
            game === "onepiece" ? onePieceImageChain(card.id, imgSrc) : undefined
          }
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
              : <NoPriceText fontSize="12px" />}
          </span>
          {/* REAL value deviation (Scrydex 7-day change) from the search
              API's weeklyChangePct. Render the movement indicator ONLY when
              it's a real non-null number — a card with no recorded change
              shows nothing, never a fabricated delta (AGENTS.md rule 2). */}
          {(() => {
            const { delta, up } = fmtWeeklyDelta(card.weeklyChangePct);
            if (delta == null) return null;
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
                {up ? "▲" : "▼"} {delta}
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
