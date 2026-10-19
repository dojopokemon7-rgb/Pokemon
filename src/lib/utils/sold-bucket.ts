/**
 * Sold-bucket row counting (QA #4).
 *
 * The "Sold" collection chip must agree with the Sold VIEW item count. The Sold
 * view (portfolio/page.tsx) consolidates sold UserCollection lots into rows keyed
 * by card + set + foil + condition + soldPrice + collection, then shows a row/item
 * count. The chip previously summed sold QUANTITY, so a single sold lot of qty 2
 * read "Sold 2" against the view's "1 item". This util collapses sold lots to the
 * SAME granularity and returns a per-collection count of consolidated rows.
 *
 * `cardId` subsumes the view's card-name + set-name keys (one card id → one
 * name/set). Condition is normalized to the graded label or "raw", matching the
 * view's `condKey` so two differently-worded non-graded conditions still merge.
 */

import { isGraded } from "./graded-price";

/** Minimal shape of a sold lot needed to derive its consolidation identity. */
export interface SoldLot {
  collectionId: string | null;
  cardId: string;
  isFoil: boolean;
  condition: string | null;
  soldPrice: number | null;
}

/** Fallback collection id for loose (collectionId == null) lots. */
export const UNCATEGORIZED_ID = "__uncat__";

/** The consolidation key for one sold lot — mirrors the Sold view's row key. */
function soldRowKey(lot: SoldLot): string {
  const condKey = isGraded(lot.condition) ? (lot.condition ?? "").trim().toLowerCase() : "raw";
  const foilKey = lot.isFoil ? "foil" : "regular";
  return `${lot.cardId}::${foilKey}::${condKey}::sold-${lot.soldPrice ?? 0}`;
}

/**
 * Counts consolidated sold ROWS per collection id. The result maps a collection
 * id (or `UNCATEGORIZED_ID` for loose lots) to how many distinct sold rows the
 * Sold view would render for it.
 */
export function countSoldRowsByCollection(lots: SoldLot[]): Map<string, number> {
  const seen = new Map<string, Set<string>>();
  for (const lot of lots) {
    const collId = lot.collectionId ?? UNCATEGORIZED_ID;
    let set = seen.get(collId);
    if (!set) seen.set(collId, (set = new Set<string>()));
    set.add(soldRowKey(lot));
  }
  const counts = new Map<string, number>();
  for (const [collId, set] of seen) counts.set(collId, set.size);
  return counts;
}
