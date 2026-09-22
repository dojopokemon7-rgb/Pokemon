"use client";

/**
 * CardDetailsPopup (F-08) — in-place card details modal.
 *
 * Opens when a card tile is clicked (Home / Explore) instead of
 * navigating to the full /search/[id] page. Shows the card image,
 * price, and grade/condition, plus "Add to Collection" and "Add to
 * Favourites" actions.
 *
 * Presentational + self-contained: the parent owns the add-to-collection
 * flow (it already has an AddCardSheet) and the favorites toggle, and
 * passes them in as callbacks. This keeps the popup reusable across the
 * search grid and the dashboard rows without duplicating that logic.
 *
 * A11y / behaviour:
 *   - role="dialog" + aria-modal, labelled by the card name.
 *   - Backdrop click and the top-right close (X) both dismiss.
 *   - Escape closes; focus moves to the close button on open and is
 *     restored to the previously-focused element on close.
 *   - Scale+fade open animation (respects prefers-reduced-motion via the
 *     global @media rule in globals.css).
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CardImage, cardInitials } from "@/components/CardImage";

export interface CardDetailsData {
  /** External card id (e.g. "base1-4", "OP01-001"). */
  externalId: string;
  name: string;
  setName?: string | null;
  imageUrl?: string | null;
  marketPrice?: number | null;
  /** Free-text grade/condition (e.g. "PSA 10"); null/absent → "Raw". */
  condition?: string | null;
  /** Game hint, threaded to the full-details link. */
  game?: "pokemon" | "onepiece";
}

interface CardDetailsPopupProps {
  card: CardDetailsData;
  isFavorite: boolean;
  onClose: () => void;
  onAddToCollection: () => void;
  onToggleFavorite: () => void;
}

const GRADED_RE = /\b(psa|bgs|cgc|sgc|beckett)\b/i;

export function CardDetailsPopup({
  card,
  isFavorite,
  onClose,
  onAddToCollection,
  onToggleFavorite,
}: CardDetailsPopupProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // "Want to Buy" persists to the Want List (F-07). Self-contained POST so
  // the popup replaces the detail page's want-to-buy toggle 1:1 (the card
  // click no longer navigates to that page). Optimistic; reverts on error.
  const [wantToBuy, setWantToBuy] = useState(false);

  async function addToWantList() {
    setWantToBuy(true);
    try {
      const res = await fetch("/api/want-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ cardId: card.externalId, intent: "BUY" }),
      });
      if (!res.ok) throw new Error("want-list add failed");
    } catch {
      setWantToBuy(false);
    }
  }

  // Focus management: remember what was focused, focus the close button
  // on open, restore focus on unmount. Also close on Escape.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  const graded = !!card.condition && GRADED_RE.test(card.condition);
  const gradeText = graded ? (card.condition as string) : "Raw";
  const price = card.marketPrice;
  const showSet = card.setName && card.setName.toLowerCase() !== "unknown set";

  const detailParams = new URLSearchParams({
    name: card.name,
    ...(card.game ? { game: card.game } : {}),
    ...(showSet ? { set: card.setName as string } : {}),
    ...(card.imageUrl ? { img: card.imageUrl } : {}),
    ...(price != null ? { price: String(price) } : {}),
  });

  return (
    <>
      {/* Backdrop / scrim — click anywhere outside the panel to close. */}
      <div
        data-testid="card-details-backdrop"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 90,
          background: "rgba(0,0,0,0.6)",
          animation: "dojo-fade-in 180ms ease-out both",
        }}
      />

      {/* Centered dialog panel. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={card.name}
        data-testid="card-details-popup"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 91,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "22px",
          pointerEvents: "none",
        }}
      >
        <div
          // Inner content stops click-through to the backdrop.
          onClick={(e) => e.stopPropagation()}
          style={{
            pointerEvents: "auto",
            width: "100%",
            maxWidth: "360px",
            maxHeight: "88vh",
            overflowY: "auto",
            background: "var(--color-dojo-card)",
            border: "1px solid var(--color-dojo-stroke)",
            padding: "18px 20px 22px",
            animation: "dojo-popup-in 200ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
          }}
        >
          {/* Header: title + close (X). */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: "12px", marginBottom: "14px" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 className="dojo-heading" style={{ fontSize: "20px", margin: 0, lineHeight: 1.2 }}>
                {card.name}
              </h2>
              {showSet && (
                <p style={{ margin: "4px 0 0", fontSize: "12px", color: "var(--color-dojo-body)" }}>
                  {card.setName}
                </p>
              )}
            </div>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close"
              title="Close"
              style={{
                flex: "none",
                width: "34px",
                height: "34px",
                border: "1px solid var(--color-dojo-stroke)",
                background: "var(--color-dojo-app)",
                color: "var(--color-dojo-ink)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
                <line x1="3" y1="3" x2="13" y2="13" />
                <line x1="13" y1="3" x2="3" y2="13" />
              </svg>
            </button>
          </div>

          {/* Card art. */}
          <div style={{ width: "62%", margin: "0 auto" }}>
            <CardImage
              src={card.imageUrl}
              alt={card.name}
              initials={cardInitials(card.name)}
              initialsSize="26px"
              style={{ background: "var(--color-dojo-raised)", border: "none" }}
            />
          </div>

          {/* Grade row — the grade/condition badge sits above the market
              price. */}
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "16px" }}>
            <div style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
              Market Price
            </div>
            {/* Grade badge — gold if graded, grey "Raw" otherwise. */}
            <span
              data-testid="card-details-grade"
              style={{
                flex: "none",
                display: "inline-block",
                padding: "5px 10px",
                fontFamily: "var(--font-display)",
                fontWeight: 700,
                fontSize: "10px",
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                border: "1px solid " + (graded ? "var(--color-dojo-gold)" : "var(--color-dojo-stroke)"),
                color: graded ? "var(--color-dojo-gold)" : "var(--color-dojo-faint)",
                background: graded ? "rgba(233,180,59,0.10)" : "transparent",
                whiteSpace: "nowrap",
              }}
            >
              {gradeText}
            </span>
          </div>

          {/* Single market price (the side-by-side Dojo/eBay comparison
              was removed per F-16). Falls back to an em dash when unknown. */}
          <div
            style={{
              marginTop: "10px",
              fontFamily: "var(--font-display)",
              fontWeight: 800,
              fontVariantNumeric: "tabular-nums",
              fontSize: "22px",
              color: price != null ? "var(--color-dojo-gold)" : "var(--color-dojo-faint)",
            }}
          >
            {price != null
              ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(price)
              : "—"}
          </div>

          {/* Actions. */}
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "20px" }}>
            <button
              type="button"
              onClick={onAddToCollection}
              className="dojo-btn dojo-btn-primary"
            >
              ADD TO COLLECTION
            </button>
            <button
              type="button"
              onClick={onToggleFavorite}
              aria-pressed={isFavorite}
              className="dojo-btn dojo-btn-outline"
            >
              {isFavorite ? "★ REMOVE FROM FAVOURITES" : "☆ ADD TO FAVOURITES"}
            </button>
            <button
              type="button"
              onClick={addToWantList}
              aria-pressed={wantToBuy}
              className="dojo-btn dojo-btn-outline"
            >
              {wantToBuy ? "✓ WANT TO BUY" : "WANT TO BUY"}
            </button>
          </div>

          {/* Escape hatch to the full detail page (kept as a secondary link
              so the popup doesn't hide the deeper eBay deal-finder view). */}
          <div style={{ marginTop: "14px", textAlign: "center" }}>
            <Link
              href={`/search/${card.externalId}?${detailParams.toString()}`}
              style={{
                fontFamily: "var(--font-display)", fontWeight: 700,
                fontSize: "9.5px", letterSpacing: "0.14em", textTransform: "uppercase",
                color: "var(--color-dojo-gold)", textDecoration: "none",
              }}
            >
              View full details ›
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
