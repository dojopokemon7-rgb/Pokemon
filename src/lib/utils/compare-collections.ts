/**
 * Compare Collections (F-22) — side-by-side stats for two collections.
 *
 * Pure + deterministic. Builds directly on the F-11 aggregator
 * (aggregateCollectionStats) so the comparison numbers always agree with
 * the dashboard's per-collection headline stats. Given the user's owned
 * items and two collection ids, it returns each side's stats; an id with no
 * matching items yields a valid $0 / 0 result (empty state, never a throw).
 */

import {
  aggregateCollectionStats,
  type AggregatableItem,
  type CollectionStats,
} from "@/lib/utils/collection-aggregation";

/** Same owned-copy row the aggregator consumes. */
export type ComparableItem = AggregatableItem;

/** One side of a comparison: the aggregated stats plus which collection. */
export interface ComparisonSide extends CollectionStats {
  collectionId: string;
}

export interface CollectionComparison {
  a: ComparisonSide;
  b: ComparisonSide;
}

/** You need at least this many collections before comparing makes sense. */
export const MIN_COLLECTIONS_TO_COMPARE = 2;

/** Prompt shown when the user doesn't have enough collections to compare. */
export const NEEDS_MORE_COLLECTIONS_MESSAGE =
  "Add another collection to compare.";

/** Whether the user has enough collections for the compare feature. */
export function canCompare(collectionCount: number): boolean {
  return collectionCount >= MIN_COLLECTIONS_TO_COMPARE;
}

/**
 * Aggregates two collections side by side. Each side reuses
 * {@link aggregateCollectionStats}, so an empty collection comes back as
 * $0 / 0 / [] rather than throwing.
 */
export function compareCollections(
  items: ComparableItem[],
  idA: string,
  idB: string
): CollectionComparison {
  return {
    a: { collectionId: idA, ...aggregateCollectionStats(items, idA) },
    b: { collectionId: idB, ...aggregateCollectionStats(items, idB) },
  };
}
