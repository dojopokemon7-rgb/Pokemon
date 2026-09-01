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
  initials,
  aspectRatio = "660 / 921",
  className,
  style,
  initialsSize = "22px",
  loading = "lazy",
}: CardImageProps) {
  // `errored` flips to true when the browser fires <img onError> — either
  // the URL 404s, the CDN blocks the request (CORP/CORS), or the file
  // returned isn't a valid image. Either way, we swap to initials.
  const [errored, setErrored] = useState(false);
  const showImage = Boolean(src) && !errored;

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
          src={src ?? undefined}
          alt={alt}
          loading={loading}
          onError={() => setErrored(true)}
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
