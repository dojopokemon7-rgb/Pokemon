/**
 * Multi-collection comparison series (pure — no I/O). Plan §6:
 *   - ONE series per collection; NEVER summed into a single total.
 *   - Time on X, collection value on Y, with shaded areas per series.
 *   - A card contributes to a collection's value ONLY within its ownership
 *     interval [addedAt, soldAt). We never value a card in a collection before
 *     it was actually added, and we stop valuing it once sold.
 *   - Value at time t uses the NEAREST real stored price point at or before t
 *     for the card (carry-forward of real data). If no real price exists at/
 *     before t, that card contributes nothing yet — an HONEST gap, never a
 *     fabricated or interpolated value.
 */

export interface HoldingInterval {
  collectionId: string; // which collection this lot belongs to (the ALL view can pre-group)
  cardId: string;
  quantity: number;
  addedAt: number; // epoch ms — ownership start (inclusive)
  soldAt: number | null; // epoch ms — ownership end (exclusive); null = still held
}

export interface PricePoint {
  cardId: string;
  at: number; // epoch ms
  price: number; // real stored market price (source-native; charts stay source-native)
}

export interface SeriesPoint {
  t: number; // epoch ms
  value: number | null; // null = honest gap (no real data to value the collection yet)
}

export interface CollectionSeries {
  collectionId: string;
  points: SeriesPoint[];
}

/** Nearest real price at or before `t` for a card, or null (carry-forward). */
function priceAtOrBefore(sorted: PricePoint[], t: number): number | null {
  // sorted ascending by `at`. Linear scan is fine for per-card point counts;
  // callers pass already-filtered per-card arrays.
  let found: number | null = null;
  for (const p of sorted) {
    if (p.at <= t) found = p.price;
    else break;
  }
  return found;
}

/**
 * Build one value series per collection over the given timeline.
 *
 * @param holdings  ownership intervals (one per lot), already grouped by the
 *                  collectionId the caller wants (for the ALL view, pass a
 *                  single synthetic collectionId across every owned lot).
 * @param prices    real stored price points (any order).
 * @param timeline  epoch-ms timestamps to evaluate, ascending.
 */
export function buildCollectionSeries(
  holdings: HoldingInterval[],
  prices: PricePoint[],
  timeline: number[]
): CollectionSeries[] {
  // Index prices per card, sorted ascending by time (for carry-forward).
  const byCard = new Map<string, PricePoint[]>();
  for (const p of prices) {
    const arr = byCard.get(p.cardId) ?? [];
    arr.push(p);
    byCard.set(p.cardId, arr);
  }
  for (const arr of byCard.values()) arr.sort((a, b) => a.at - b.at);

  // Group holdings by collection.
  const byCollection = new Map<string, HoldingInterval[]>();
  for (const h of holdings) {
    const arr = byCollection.get(h.collectionId) ?? [];
    arr.push(h);
    byCollection.set(h.collectionId, arr);
  }

  const series: CollectionSeries[] = [];
  for (const [collectionId, lots] of byCollection) {
    const points: SeriesPoint[] = timeline.map((t) => {
      let total = 0;
      let anyContribution = false;
      for (const lot of lots) {
        // Ownership interval: contributes only within [addedAt, soldAt).
        if (t < lot.addedAt) continue;
        if (lot.soldAt != null && t >= lot.soldAt) continue;
        const price = priceAtOrBefore(byCard.get(lot.cardId) ?? [], t);
        if (price == null) continue; // honest gap — no real data to value this lot yet
        total += price * lot.quantity;
        anyContribution = true;
      }
      // If nothing in this collection could be valued at t (nothing owned yet,
      // or no real price exists), emit a null gap rather than a fabricated 0.
      return { t, value: anyContribution ? total : null };
    });
    series.push({ collectionId, points });
  }
  return series;
}
