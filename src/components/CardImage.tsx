"use client";

/**
 * CardImage — single source of truth for rendering a card thumbnail.
 *
 * Handles the three states every tile in the app needs to cover:
 *   1. `src` is present AND loads successfully → shows the image
 *   2. `src` is null/undefined → renders the initials placeholder
 *   3. `src` fails to load (404, CORS, network) → falls back to initials
 *
 * Client feedback (Phase 3.3): every card tile must have this same
 * fallback so a broken image icon never appears. Consolidating it here
 * removes 4+ near-identical copies of the initials-placeholder JSX
 * across search, portfolio, dashboard, and collection-add tiles.
 *
 * Uses a plain <img>, not next/image — most card art is on
 * cross-origin CDNs (Pokémon TCG, Bandai proxy, TCGdex) and the extra
 * remotePatterns configuration + optimization overhead isn't worth
 * it for tiles this small.
 */

import { useState } from "react";

interface CardImageProps {
  src?: string | null;
  alt: string;
  /**
   * Ordered image URLs to try, best first. On <img onError> the component
   * advances to the next entry before giving up to initials. When omitted,
   * `src` is the only URL tried. Used for One Piece cards, where a source
   * can 404 or be CORP-blocked and the next tier should be attempted.
   */
  fallbackChain?: string[];
  /** Two-letter initials derived from the card name, e.g. "CZ" for Charizard. */
  initials: string;
  /** CSS aspect-ratio for the container. Card art defaults to Pokémon's 660×921. */
  aspectRatio?: string;
  /** Width class or explicit width — accepts anything a style prop would. */
  className?: string;
  /** Override container styling (background, border, etc.). */
  style?: React.CSSProperties;
  /** Font-size for the initials fallback (defaults to 22px). */
  initialsSize?: string;
  loading?: "lazy" | "eager";
}

/** Derives up to two initials from a card name. "Monkey D. Luffy" → "MD". */
export function cardInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function CardImage({
  src,
  alt,
  fallbackChain,
  initials,
  aspectRatio = "660 / 921",
  className,
  style,
  initialsSize = "22px",
  loading = "lazy",
}: CardImageProps) {
  // The ordered list of URLs to try. Prefer an explicit chain; otherwise the
  // single `src`. De-duped, empties dropped.
  const chain = (fallbackChain?.length ? fallbackChain : [src]).filter(
    (u): u is string => typeof u === "string" && u.length > 0
  );
  // Index into `chain`. On <img onError> (404, CORP/CORS block, non-image
  // body) we advance to the next candidate; once past the end we give up to
  // the initials placeholder.
  const [idx, setIdx] = useState(0);
  const current = chain[idx];
  const showImage = Boolean(current);

  const handleError = () => setIdx((i) => i + 1);

  return (
    <div
      className={className}
      style={{
        width: "100%",
        aspectRatio,
        background: "var(--color-dojo-card)",
        border: "1px solid var(--color-dojo-stroke)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        ...style,
      }}
    >
      {showImage ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          // key on the URL so React remounts the <img> when we advance the
          // chain — guarantees the browser refetches the next candidate.
          key={current}
          src={current}
          alt={alt}
          loading={loading}
          // Off-main-thread decode so a grid of tiles doesn't jank the
          // scroll/paint while images decode. The container's aspect-ratio
          // already reserves the box, so there's no layout shift to guard.
          decoding="async"
          onError={handleError}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
        />
      ) : (
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 800,
            fontSize: initialsSize,
            color: "var(--color-dojo-gold)",
            letterSpacing: "0.06em",
          }}
          aria-hidden="true"
        >
          {initials}
        </span>
      )}
    </div>
  );
}

/**
 * NoPriceText — the shared "no price data" label.
 *
 * Renders small gray "No price data" text in place of a bare "—" when a
 * card has no market price (marketPrice null/0 with no upstream source).
 * Used on the search/trending grid tiles so a priceless card reads as an
 * explicit state rather than a cryptic dash. Font-size is overridable so it
 * can sit where a price number would on tiles of different sizes.
 */
export function NoPriceText({ fontSize = "11px" }: { fontSize?: string }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-body)",
        fontWeight: 400,
        fontSize,
        color: "var(--color-dojo-faint)",
      }}
    >
      No price data
    </span>
  );
}
