/**
 * Maps the dashboard portfolio-chart range ids (DashboardClient RANGES:
 * 1D, 7D, 1M, 3M, 6M, MAX) to the analytics taxonomy (1W|1M|3M|1Y|ALL).
 * Honest mapping only: 1D and 6M have NO taxonomy equivalent, so they return
 * null (caller sends no event) rather than inventing a bucket.
 */
export type AnalyticsChartRange = "1W" | "1M" | "3M" | "1Y" | "ALL";

const MAP: Record<string, AnalyticsChartRange> = {
  "7D": "1W",
  "1M": "1M",
  "3M": "3M",
  "1Y": "1Y",
  MAX: "ALL",
  ALL: "ALL",
};

export function toAnalyticsChartRange(range: string): AnalyticsChartRange | null {
  return MAP[range] ?? null;
}
