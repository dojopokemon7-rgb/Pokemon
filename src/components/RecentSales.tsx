"use client";

import { useQuery } from "@tanstack/react-query";

// ── Recent Sales — REAL eBay SOLD records from Scrydex's documented listings
// endpoint (/api/cards/[id]/ebay-sold → Scrydex source=ebay, filtered to
// records with sold_at). These are completed sales, NOT active listings — we
// never fall back to active listings. Empty / unavailable / pending-approval →
// "No recent sales found" (plan §4).
//
// NOTE: this lives in its OWN component file (not inline in the card-detail
// page) because Next's App Router forbids a page.tsx from exporting anything
// other than the default + known route exports — a named export there fails
// the build typegen. Importing it here lets the unit test render it in
// isolation. The call site passes NO grade/variant this phase (unfiltered —
// design §4.1 option b); the optional grade?/variant? params are kept for a
// future single-grade sold-record filter.
interface SoldRecord {
  itemId: string;
  source: string | null;
  title: string | null;
  price: number | null;
  currency: string | null;
  soldAt: string | null;
  grade: string | null;
  company: string | null;
  url: string | null;
}

export function RecentSales({
  id, setName, rarity, grade, variant,
}: {
  id: string; setName: string; rarity: string; grade?: string; variant?: string;
}) {
  const { data, isLoading } = useQuery<{ listings: SoldRecord[] }>({
    queryKey: ["ebay-sold", id, grade ?? "", variant ?? ""],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (grade) qs.set("grade", grade);
      if (variant) qs.set("variant", variant);
      const res = await fetch(`/api/cards/${encodeURIComponent(id)}/ebay-sold?${qs.toString()}`);
      if (!res.ok) return { listings: [] };
      return res.json();
    },
    staleTime: 24 * 60 * 60_000, // matches the route's 24h shared cache
  });

  const listings = data?.listings ?? [];
  const heading = { fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px", letterSpacing: "0.18em", textTransform: "uppercase" as const, color: "var(--color-dojo-body)" };

  return (
    <>
      <div style={{ marginTop: "22px", display: "flex", alignItems: "baseline" }}>
        <span style={heading}>Recent Sales</span>
        {!isLoading && listings.length > 0 && (
          <span style={{ marginLeft: "auto", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
            {listings.length} sale{listings.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {isLoading ? (
        <div style={{ marginTop: "12px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "22px 15px", textAlign: "center" }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12px", color: "var(--color-dojo-faint)" }}>Checking sold records…</span>
        </div>
      ) : listings.length === 0 ? (
        <div style={{ marginTop: "12px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "22px 15px", textAlign: "center" }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12px", color: "var(--color-dojo-faint)" }}>No recent sales found</span>
        </div>
      ) : (
        <div style={{ marginTop: "12px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "2px 15px 6px" }}>
          {listings.map((l) => {
            const soldLabel = l.soldAt ? new Date(l.soldAt.replace(/\//g, "-")).toLocaleDateString() : "";
            const gradeLabel = l.company && l.grade ? `${l.company} ${l.grade}` : l.grade ?? "";
            const sub = [gradeLabel, setName, rarity].filter(Boolean).join(" · ");
            const priceStr = l.price != null && l.price > 0 ? new Intl.NumberFormat("en-US", { style: "currency", currency: l.currency ?? "USD" }).format(l.price) : "—";
            const Row = (
              <div style={{ display: "flex", alignItems: "center", gap: "11px", padding: "13px 0", borderBottom: "1px solid var(--color-dojo-divider)" }}>
                <div aria-hidden="true" style={{ flex: "none", width: "34px", height: "34px", background: "var(--color-dojo-gold)", color: "var(--color-dojo-app)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px" }}>
                  {(l.source ?? "e").charAt(0).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "12.5px", color: "var(--color-dojo-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    Sold{soldLabel ? ` ${soldLabel}` : ""}
                  </div>
                  {sub && (
                    <div style={{ marginTop: "2px", fontSize: "10.5px", color: "var(--color-dojo-body)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>
                  )}
                </div>
                <div style={{ textAlign: "right", flex: "none" }}>
                  <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13.5px", fontVariantNumeric: "tabular-nums", color: "var(--color-dojo-ink)" }}>{priceStr}</div>
                  {l.url && (
                    <a href={l.url} target="_blank" rel="noopener noreferrer" style={{ marginTop: "3px", display: "inline-block", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "9px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-gold)", textDecoration: "none" }}>
                      View sale ›
                    </a>
                  )}
                </div>
              </div>
            );
            return <div key={l.itemId}>{Row}</div>;
          })}
        </div>
      )}
    </>
  );
}
