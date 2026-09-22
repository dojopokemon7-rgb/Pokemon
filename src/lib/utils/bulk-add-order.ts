/**
 * Bulk Add Ordering (F-15).
 *
 * The collection list sorts by `addedAt desc`. When a batch of cards is
 * added in one request, relying on the DB's per-row `now()` default makes
 * the LAST item in the batch get the latest timestamp — so `addedAt desc`
 * returns the batch reversed. This helper instead stamps each row with an
 * explicit, strictly-decreasing timestamp derived from a single base time,
 * so that after the `addedAt desc` sort the batch appears at the FRONT in
 * its original selection order.
 *
 * For a batch [C, D, E] and base T:
 *   C → T+2ms, D → T+1ms, E → T+0ms   (all >= T, strictly distinct)
 *   sorted desc → C, D, E              (selection order preserved, front)
 *
 * Using `base = Date.now()` at call time keeps the whole batch newer than
 * anything added before this request.
 */

export interface BulkAddStamp<T = string> {
  cardId: T;
  addedAt: Date;
}

/**
 * Assigns front-loaded, strictly-decreasing `addedAt` timestamps to a batch
 * so `orderBy addedAt desc` yields the items in the given selection order.
 *
 * @param cardIds Items in the order the user selected them.
 * @param base    Base time; the first item is stamped highest so it sorts
 *                first. Defaults to now.
 */
export function assignBulkAddOrder<T = string>(
  cardIds: readonly T[],
  base: Date = new Date()
): BulkAddStamp<T>[] {
  const n = cardIds.length;
  return cardIds.map((cardId, i) => ({
    cardId,
    // First selected → largest offset → sorts first under `addedAt desc`.
    addedAt: new Date(base.getTime() + (n - 1 - i)),
  }));
}
