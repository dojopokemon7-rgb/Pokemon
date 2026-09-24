/**
 * Streaming skeleton for /dashboard.
 *
 * Rendered instantly on navigation while the server component awaits the
 * user's collection from Prisma, so the tab switch shows structure right
 * away instead of a blank frame. Mirrors the dark dojo-pulse placeholders
 * used inline elsewhere (search SkeletonCard, portfolio loading grid).
 */
const pulse = "dojo-pulse 1.5s ease-in-out infinite";

export default function DashboardLoading() {
  return (
    <div style={{ padding: "16px 22px 24px" }} aria-busy="true" aria-label="Loading dashboard">
      {/* Headline value block */}
      <div style={{ height: "12px", width: "40%", background: "var(--color-dojo-raised)", animation: pulse }} />
      <div style={{ marginTop: "10px", height: "40px", width: "60%", background: "var(--color-dojo-raised)", animation: pulse }} />

      {/* Chart area */}
      <div style={{ marginTop: "20px", height: "170px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", animation: pulse }} />

      {/* Card rows */}
      <div style={{ marginTop: "24px", display: "flex", flexDirection: "column", gap: "10px" }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} style={{ display: "flex", gap: "12px", alignItems: "center", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "12px 13px" }}>
            <div style={{ width: "40px", aspectRatio: "660 / 921", background: "var(--color-dojo-raised)", animation: pulse }} />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "6px" }}>
              <div style={{ height: "13px", width: "60%", background: "var(--color-dojo-raised)", animation: pulse }} />
              <div style={{ height: "11px", width: "40%", background: "var(--color-dojo-raised)", animation: pulse }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
