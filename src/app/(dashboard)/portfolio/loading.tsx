/**
 * Streaming skeleton for /portfolio.
 *
 * Shows the search bar + total-value + a card grid placeholder instantly on
 * navigation. Matches the inline loading grid the page already renders while
 * its ["portfolio-collection"] query is in flight, so the tab switch never
 * flashes blank.
 */
const pulse = "dojo-pulse 1.5s ease-in-out infinite";

export default function PortfolioLoading() {
  return (
    <div style={{ padding: "6px 22px 24px" }} aria-busy="true" aria-label="Loading portfolio">
      {/* Search bar */}
      <div style={{ marginTop: "16px", height: "44px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", animation: pulse }} />

      {/* Total value */}
      <div style={{ marginTop: "20px", height: "12px", width: "30%", background: "var(--color-dojo-raised)", animation: pulse }} />
      <div style={{ marginTop: "8px", height: "32px", width: "50%", background: "var(--color-dojo-raised)", animation: pulse }} />

      {/* Card grid (2-col) */}
      <div style={{ marginTop: "24px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} style={{ background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "11px" }}>
            <div style={{ width: "100%", aspectRatio: "660 / 921", background: "var(--color-dojo-raised)", animation: pulse }} />
            <div style={{ marginTop: "9px", height: "13px", width: "75%", background: "var(--color-dojo-raised)", animation: pulse }} />
            <div style={{ marginTop: "6px", height: "11px", width: "50%", background: "var(--color-dojo-raised)", animation: pulse }} />
          </div>
        ))}
      </div>
    </div>
  );
}
