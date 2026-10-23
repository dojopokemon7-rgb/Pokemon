/**
 * Pure helpers for the dashboard comparison chart (Screen 09/10). Extracted so
 * the alignment logic is unit-testable in isolation (AGENTS.md rule 11) and so
 * DashboardClient and the headline-change util share ONE honest alignment rule.
 *
 * AGENTS.md RULE 2 (never fabricate): the per-collection value series come from
 * `buildCollectionHistories` as date-stamped points with honest null gaps
 * (value null = the collection had nothing valuable to show at that date — not
 * owned yet, or no real stored price). A collection that started LATER than
 * another has null gaps on the leading dates. The OLD dashboard dropped those
 * nulls and then RIGHT-ALIGNED the shorter series by INDEX, back-filling its
 * first real value leftward — which DREW that value for dates BEFORE the
 * collection was owned/priced (audit 04 F-03). That is a visual fabrication.
 *
 * The fix: align every series on the UNION OF REAL DATES. Each series carries
 * its own real value forward from its FIRST real date onward; for any union
 * date BEFORE that series' first real date it stays an honest gap (NaN), which
 * AreaChart renders as "no drawn value" so the line simply starts at the first
 * real point. We never carry a value BACKWARD across dates the series did not
 * yet hold.
 */

import type { AreaChartDatum, AreaChartSeries } from "@/components/AreaChart";

/** One drawable collection series: date-stamped points, value null = honest gap. */
export interface DashboardSeries {
  id: string;
  name: string;
  color: string;
  /** Oldest → newest; value null = honest gap (no real data at that date). */
  points: readonly { date: string; value: number | null }[];
}

/** Real (non-null) points of a series, oldest → newest. */
function realPoints(s: DashboardSeries): { date: string; value: number }[] {
  return s.points.filter(
    (p): p is { date: string; value: number } => typeof p.value === "number"
  );
}

/**
 * A series is DRAWABLE when it has >= 2 real points (same rule the chart uses to
 * decide a line vs its honest empty state). A 0/1-point series carries no trend.
 */
export function drawableSeries(seriesList: readonly DashboardSeries[]): DashboardSeries[] {
  return seriesList.filter((s) => realPoints(s).length >= 2);
}

/**
 * Value of a series at a union date: the nearest real point AT OR BEFORE that
 * date (carry-forward). Returns NaN for a date BEFORE the series' first real
 * point — an honest gap, NEVER the first real value back-filled leftward.
 */
function valueAtDateOrGap(real: { date: string; value: number }[], date: string): number {
  if (real.length === 0 || date < real[0].date) return NaN; // before first real point → honest gap
  let carried = real[0].value;
  for (const p of real) {
    if (p.date <= date) carried = p.value;
    else break;
  }
  return carried;
}

/**
 * buildDashboardMatrix — assemble the multi-series AreaChart matrix from the
 * drawable collection series, aligned on the UNION of their real dates. Each
 * datum carries a real number for a series only from its first real date
 * onward; earlier dates are NaN (honest gap → AreaChart draws no point there).
 * Series are NEVER summed — one AreaChartSeries per collection.
 */
export function buildDashboardMatrix(
  seriesList: readonly DashboardSeries[]
): { data: AreaChartDatum[]; series: AreaChartSeries[] } {
  const drawable = drawableSeries(seriesList);
  if (drawable.length === 0) return { data: [], series: [] };

  const perSeriesReal = drawable.map((s) => ({ s, real: realPoints(s) }));
  const allDates = [...new Set(perSeriesReal.flatMap(({ real }) => real.map((p) => p.date)))].sort();

  const data: AreaChartDatum[] = allDates.map((date) => {
    // The real points carry no formatted axis label on the dashboard (the chart
    // omits x-axis dates by design — see DashboardClient), so label stays "".
    const datum: AreaChartDatum = { label: "" };
    for (const { s, real } of perSeriesReal) {
      datum[s.id] = valueAtDateOrGap(real, date);
    }
    return datum;
  });

  const series: AreaChartSeries[] = drawable.map((s) => ({
    valueKey: s.id,
    label: s.name,
    color: s.color,
  }));

  return { data, series };
}

export interface OverallChange {
  /** Absolute change (last aggregate − first aggregate), or null when < 2
   *  aggregate dates have a value. */
  delta: number | null;
  /** Percentage relative to the first aggregate value, or null on insufficient
   *  history OR a zero first value (no divide-by-zero). */
  pct: number | null;
}

const NONE: OverallChange = { delta: null, pct: null };

/**
 * Aggregate the drawable collections' real series into ONE value curve over the
 * union of real dates, then take (last − first). A series contributes to a
 * union date ONLY from its first real date onward (carry-forward of real data);
 * before that it contributes NOTHING — so the aggregate first/last match the
 * HONEST drawn chart, never a leftward-back-filled baseline (audit 04 F-03).
 */
export function dashboardOverallChange(
  seriesList: readonly DashboardSeries[]
): OverallChange {
  const perSeriesReal = drawableSeries(seriesList).map((s) => realPoints(s));
  if (perSeriesReal.length === 0) return NONE;

  const allDates = [...new Set(perSeriesReal.flatMap((r) => r.map((p) => p.date)))].sort();
  if (allDates.length < 2) return NONE;

  // Aggregate value at a union date: sum each series' carry-forward value, but a
  // series with no real point AT OR BEFORE this date (NaN) adds nothing.
  const aggregateAt = (date: string): number => {
    let sum = 0;
    for (const real of perSeriesReal) {
      const v = valueAtDateOrGap(real, date);
      if (Number.isFinite(v)) sum += v;
    }
    return sum;
  };

  const first = aggregateAt(allDates[0]);
  const last = aggregateAt(allDates[allDates.length - 1]);
  const delta = last - first;
  const pct = first > 0 ? (delta / first) * 100 : null;
  return { delta, pct };
}

/**
 * True when at least one series is drawable (>= 2 real points) — i.e. the chart
 * draws a line rather than its honest empty state. Reuses the EXACT drawable
 * rule so the range-selector gate can never drift from the chart's decision.
 */
export function hasDashboardHistory(seriesList: readonly DashboardSeries[]): boolean {
  return drawableSeries(seriesList).length > 0;
}

/**
 * Scope the drawable series to the focused collection (Bug #5). When a focus
 * pill is active AND still selected (`isActive(focusedId)`), the chart, headline
 * change and range-tab gate all narrow to that ONE collection's series; a null
 * or no-longer-active focus falls back to ALL series. This is the EXACT rule
 * `headlineChange` already inlined — sharing it here keeps the DRAWN lines, the
 * "+$X · +Y%" badge and the range gate from ever disagreeing. Pure; fabricates
 * nothing (RULE 2) — it only filters an existing honest series list.
 */
export function scopeSeriesToFocus(
  seriesList: readonly DashboardSeries[],
  focusedId: string | null,
  isActive: (id: string) => boolean
): DashboardSeries[] {
  return focusedId && isActive(focusedId)
    ? seriesList.filter((s) => s.id === focusedId)
    : [...seriesList];
}
