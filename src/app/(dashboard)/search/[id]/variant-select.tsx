"use client";

import { variantLabel } from "@/lib/utils/raw-price";

/**
 * Variant picker for the card-detail page. Renders ONLY when the card has more
 * than one stored variant (never invents a selector for single-variant cards).
 */
export function VariantSelect({
  variants,
  value,
  onChange,
}: {
  variants: string[];
  value: string | null;
  onChange: (v: string) => void;
}) {
  if (variants.length <= 1) return null;
  return (
    <div style={{ marginTop: "14px", display: "flex", alignItems: "center", gap: "10px" }}>
      <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
        Variant
      </span>
      <select
        data-testid="variant-select"
        aria-label="Variant"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        style={{
          flex: 1, minWidth: 0, height: "34px", padding: "0 10px", borderRadius: 0,
          border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-app)",
          color: "var(--color-dojo-ink)", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12px",
        }}
      >
        {variants.map((v) => (
          <option key={v} value={v}>{variantLabel(v)}</option>
        ))}
      </select>
    </div>
  );
}
