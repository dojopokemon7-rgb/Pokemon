/**
 * Overall portfolio change — the dashboard headline "+$X · +Y%" badge.
 *
 * AGENTS.md RULE 2 (never fabricate): the headline change must be a REAL value
 * derived from the SAME per-collection value series that draws the comparison
 * chart, so the number agrees with the curve the user sees. It is NOT a
 * hardcoded per-range constant (the old OVERALL_PCT_BY_RANGE lie).
 *
 * Honest-null contract: if the selected scope has FEWER THAN 2 real valued
 * aggregate points in the range (not enough history — e.g. a lot added today),
 * there is no honest change to show → delta/pct are null and the UI renders
 * "—", never a fabricated number and never a misleading 0%. A first aggregate
 * value of 0 also yields a null pct (no divide-by-zero).
 */

/** One collection's drawable value series — real points only (null gaps
 *  already dropped), oldest → newest. Mirrors DashboardClient's chartSeriesList
 *  `data` shape so the headline reuses the exact chart input. */
export interface ValueSeries {
  data: readonly { value: number }[];
}

export interface OverallChange {
  /** Absolute change (latest aggregate − first aggregate), or null when there
   *  aren't ≥2 real aggregate points. */
  delta: number | null;
  /** Percentage change relative to the first aggregate value, or null when
   *  insufficient history OR the first value is 0 (no divide-by-zero). */
  pct: number | null;
}

const NONE: OverallChange = { delta: null, pct: null };

/**
 * Aggregate the selected collections' real series into one value curve, then
 * take (last − first). Series of differing length are RIGHT-ALIGNED and
 * left-padded by carrying each series' first real value backward — the exact
 * alignment MultiLineComparisonChart uses — so the aggregate first/last points
 * match the drawn chart's left/right edges.
 */
export function computeOverallChange(seriesList: readonly ValueSeries[]): OverallChange {
  // Only series with ≥2 real points contribute a trend (same gate the chart
  // uses to decide a series is drawable); a 0/1-point series carries no change.
  const drawable = seriesList.filter((s) => s.data.length >= 2);
  if (drawable.length === 0) return NONE;

  const width = Math.max(...drawable.map((s) => s.data.length));
  if (width < 2) return NONE;

  // Aggregate value at a given aligned x-index (0 = oldest, width-1 = newest).
  const aggregateAt = (i: number): number => {
    let sum = 0;
    for (const s of drawable) {
      const offset = width - s.data.length; // right-align shorter series
      const src = i < offset ? s.data[0] : s.data[i - offset];
      sum += src.value;
    }
    return sum;
  };

  const first = aggregateAt(0);
  const last = aggregateAt(width - 1);

  const delta = last - first;
  const pct = first > 0 ? (delta / first) * 100 : null;
  return { delta, pct };
}
