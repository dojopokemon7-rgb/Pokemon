/**
 * Collection aggregation (F-11) — dashboard headline stats scoped to a
 * selected collection (or all of them).
 *
 * Pure + deterministic: given the user's owned items and a selection, it
 * returns the total market value, card count, and a chart series. The
 * dashboard uses this both for the default "All Collections" view and when
 * the user picks a specific collection from the selector.
 */

/** Sentinel selection meaning "aggregate across every collection". */
export const ALL_COLLECTIONS = "all" as const;

/** The minimal item shape needed to aggregate: the dashboard's owned-copy
 *  row (card market price, quantity) plus its F-10 collection membership. */
export interface AggregatableItem {
  quantity: number;
  purchasePrice?: number | null;
  collectionId: string | null;
  card: { marketPrice: number | null };
}

export interface CollectionStats {
  totalValue: number;
  cardCount: number;
  /** Chart series for the value sparkline; empty when there's nothing to plot. */
  chartData: { value: number }[];
}

/** Number of points in the aggregated sparkline series. */
const CHART_POINTS = 12;

/**
 * Builds a simple ascending series that ends exactly on `total`, so the
 * chart's right edge agrees with the displayed value. Returns an empty
 * array for a zero/empty total (empty-state → no line, no crash).
 */
function buildChartData(total: number): { value: number }[] {
  if (total <= 0) return [];
  const start = total * 0.85; // gentle upward drift into the current value
  const step = (total - start) / (CHART_POINTS - 1);
  const data: { value: number }[] = [];
  for (let i = 0; i < CHART_POINTS; i++) {
    data.push({ value: Math.round((start + step * i) * 100) / 100 });
  }
  data[data.length - 1] = { value: total }; // pin the last point on total
  return data;
}

/**
 * Aggregates owned items for the given selection.
 *
 * @param items      All of the user's owned-copy rows.
 * @param selectedId `ALL_COLLECTIONS` for everything, or a specific
 *                   collection id to scope to. An id with no matching items
 *                   yields a valid empty result (0 / 0 / []), never a throw.
 */
export function aggregateCollectionStats(
  items: AggregatableItem[],
  selectedId: string
): CollectionStats {
  const scoped =
    selectedId === ALL_COLLECTIONS
      ? items
      : items.filter((i) => i.collectionId === selectedId);

  let totalValue = 0;
  let cardCount = 0;
  for (const i of scoped) {
    totalValue += (i.card.marketPrice ?? 0) * i.quantity;
    cardCount += i.quantity;
  }
  totalValue = Math.round(totalValue * 100) / 100;

  return { totalValue, cardCount, chartData: buildChartData(totalValue) };
}
