"use client";

/**
 * CollectionBucketBar (F-#8) — the five per-collection buckets as a chip bar.
 *
 * Presentational only: it renders the counts from `GET /api/collections.buckets`
 * (the `["collections"]` TanStack query). Main · All · Want to Buy · Want to Sell
 * · Sold. Main/All/Sold are summed QUANTITIES; Buy/Sell are ROW COUNTS (design
 * §6a). Uses design tokens --color-dojo-*, square corners (radius 0 by design),
 * hard-offset shadows (no blur).
 */

export interface CollectionBuckets {
  main: number;
  all: number;
  buy: number;
  sell: number;
  sold: number;
}

const CHIPS: { key: keyof CollectionBuckets; label: string }[] = [
  { key: "main", label: "Main" },
  { key: "all", label: "All" },
  { key: "buy", label: "Want to Buy" },
  { key: "sell", label: "Want to Sell" },
  { key: "sold", label: "Sold" },
];

const chip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  padding: "5px 9px",
  border: "1px solid var(--color-dojo-stroke)",
  // Hard-offset shadow, NO blur (brand rule).
  boxShadow: "2px 2px 0 var(--color-dojo-stroke)",
  background: "var(--color-dojo-card)",
  fontFamily: "var(--font-display)",
  fontWeight: 700,
  fontSize: "9px",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--color-dojo-faint)",
};

const countStyle: React.CSSProperties = {
  fontWeight: 800,
  color: "var(--color-dojo-gold)",
};

export function CollectionBucketBar({ buckets }: { buckets: CollectionBuckets }) {
  return (
    <div
      role="list"
      aria-label="Collection buckets"
      style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "8px" }}
    >
      {CHIPS.map(({ key, label }) => (
        <span key={key} role="listitem" data-testid={`bucket-chip-${key}`} style={chip}>
          {label}
          <span style={countStyle}>{buckets[key]}</span>
        </span>
      ))}
    </div>
  );
}
