"use client";

/**
 * FindOnEbayLink — small gold link/button that deep-links to eBay's
 * public HTML search for a given card name (+ optional set).
 *
 * Rendered on every tile in the app (search results, trending grid,
 * card detail) so the client can always click through to real eBay
 * listings even while the Browse API is running against the sandbox
 * environment (which returns 0 items for most queries).
 *
 * IMPORTANT — nesting rules:
 *   The trending & search-result tiles wrap the whole card in a
 *   Next.js <Link> to the detail page. Nesting an <a> inside another
 *   <a> is invalid HTML, so this component renders a native <button>
 *   and calls `window.open()` on click. `stopPropagation()` also
 *   prevents the click from bubbling to the outer Link and navigating
 *   to the detail page unexpectedly.
 */

import { ArrowRight } from "./ArrowRight";
import { buildEbaySearchUrl } from "@/lib/utils/price-comparison";

interface FindOnEbayLinkProps {
  /** Card name — the primary search term (e.g. "Charizard"). */
  name: string;
  /** Optional set name to disambiguate (e.g. "Base Set"). */
  setName?: string;
  /** Optional card code (e.g. "OP01-001") — used verbatim when it's
   *  a Bandai-style code that eBay sellers include in listing titles. */
  cardCode?: string;
  /** Visual variant — inline is a plain gold text link; button is boxed. */
  variant?: "inline" | "button";
  /** Optional style override for the outer element. */
  style?: React.CSSProperties;
}

export function FindOnEbayLink({
  name,
  setName,
  cardCode,
  variant = "inline",
  style,
}: FindOnEbayLinkProps) {
  const href = buildEbaySearchUrl(name, setName, cardCode);

  const openEbay = (e: React.MouseEvent) => {
    // Don't let the click bubble to a parent <Link> (which would try to
    // navigate to the card-detail page instead of opening eBay).
    e.preventDefault();
    e.stopPropagation();
    window.open(href, "_blank", "noopener,noreferrer");
  };

  if (variant === "button") {
    return (
      <button
        type="button"
        onClick={openEbay}
        title="Find on eBay (opens in a new tab)"
        aria-label="Find on eBay"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          height: "40px",
          padding: "0 16px",
          border: "1px solid var(--color-dojo-stroke)",
          background: "transparent",
          color: "var(--color-dojo-gold)",
          fontFamily: "var(--font-display)",
          fontWeight: 800,
          fontSize: "10.5px",
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          cursor: "pointer",
          ...style,
        }}
      >
        Find on eBay
        <ArrowRight />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={openEbay}
      title="Find on eBay (opens in a new tab)"
      aria-label="Find on eBay"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        border: "none",
        background: "none",
        padding: 0,
        color: "var(--color-dojo-gold)",
        fontFamily: "var(--font-display)",
        fontWeight: 700,
        fontSize: "10px",
        letterSpacing: "0.10em",
        textTransform: "uppercase",
        cursor: "pointer",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      Find on eBay ›
    </button>
  );
}
