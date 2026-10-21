/**
 * Format a REAL weekly % change (Scrydex `trends.days_7`, stored as
 * `Card.weeklyChangePct`) into a display delta label + direction.
 *
 * Null/undefined in → `{ delta: null }` out: the caller renders NO movement
 * indicator (the "—" state on the card-detail page). This helper NEVER
 * fabricates a value — a card with no recorded change shows nothing, never a
 * hash-derived or zeroed number (AGENTS.md rule 2).
 *
 * Extracted from DashboardClient's local `fmtDelta` so the dashboard, the
 * trending route, and the search tiles share ONE null-delta contract instead
 * of each reinventing it (and the old search tiles inventing a fake one).
 */
export function fmtWeeklyDelta(
  pct: number | null | undefined
): { delta: string | null; up: boolean } {
  if (typeof pct !== "number") return { delta: null, up: true };
  return { delta: `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`, up: pct >= 0 };
}
