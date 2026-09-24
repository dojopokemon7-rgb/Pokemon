/**
 * Streaming skeleton for /search (Explore).
 *
 * Shown instantly on navigation while the client search page hydrates and
 * its trending feed loads. Mirrors the page's own SkeletonCard grid so the
 * transition into the real content is seamless.
 */
const pulse = "dojo-pulse 1.5s ease-in-out infinite";

export default function SearchLoading() {
  return (
    <div style={{ padding: "12px 22px 24px" }} aria-busy="true" aria-label="Loading search">
      {/* Search input */}
      <div style={{ height: "48px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", animation: pulse }} />

      {/* Section label */}
      <div style={{ marginTop: "18px", height: "12px", width: "45%", background: "var(--color-dojo-raised)", animation: pulse }} />

      {/* Trending card grid */}
      <div className="dojo-card-grid" style={{ marginTop: "12px" }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", overflow: "hidden" }}>
            <div style={{ aspectRatio: "660 / 921", background: "var(--color-dojo-raised)", animation: pulse }} />
            <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: "6px" }}>
              <div style={{ height: "13px", width: "70%", background: "var(--color-dojo-raised)", animation: pulse }} />
              <div style={{ height: "11px", width: "45%", background: "var(--color-dojo-raised)", animation: pulse }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
