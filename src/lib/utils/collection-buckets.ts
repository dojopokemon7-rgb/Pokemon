/**
 * Per-collection 5-bucket selector (F-#8, design §5).
 *
 * Pure, client-safe, unit-tested in isolation. Takes already-fetched rows plus
 * a scope and returns the five buckets. It does NOT query; the caller fetches
 * once and passes rows in. Want rows are passed alongside owned rows because
 * they live in a different table.
 *
 * Main == All (within a collection) is enforced in ONE place (here), so no
 * caller can drift them apart.
 */

import type { CollectionScope } from "@/lib/utils/collection-scope";

export type BucketId = "main" | "all" | "buy" | "sell" | "sold";

/** Minimal owned-lot shape the selector needs. */
export interface BucketLot {
  collectionId: string | null;
  isSold: boolean;
}
/** Minimal want-row shape the selector needs. */
export interface BucketWant {
  collectionId: string | null;
  intent: "BUY" | "SELL" | "TRADE";
}

export interface Buckets<L, W> {
  main: L[]; // active lots in scope (== all within a collection)
  all: L[]; // same list as `main` within a collection; union when scope is top-level
  buy: W[]; // WantListItem intent=BUY scoped by collectionId
  sell: W[]; // WantListItem intent=SELL scoped by collectionId
  sold: L[]; // isSold lots in scope
}

/** True when a row belongs to the given scope (null-safe for loose/all). */
function inScope(rowCollectionId: string | null, scope: CollectionScope): boolean {
  if (scope.kind === "all") return true;
  if (scope.kind === "loose") return rowCollectionId === null;
  return rowCollectionId === scope.id;
}

/**
 * Partition owned lots + want rows into the five buckets for a scope.
 * Pure: identical inputs → identical output; no I/O, no Date.now, no mutation.
 */
export function selectBuckets<L extends BucketLot, W extends BucketWant>(
  lots: L[],
  wants: W[],
  scope: CollectionScope
): Buckets<L, W> {
  const scopedLots = lots.filter((l) => inScope(l.collectionId, scope));
  const active = scopedLots.filter((l) => !l.isSold);
  const sold = scopedLots.filter((l) => l.isSold);
  const scopedWants = wants.filter((w) => inScope(w.collectionId, scope));
  // Main and Sold are PER-COLLECTION concepts (FR-2.1 / FR-5): they are only
  // defined for a collection/loose scope. Top-level All is a UNION view (the `all`
  // bucket). So for {kind:"all"} we return main/sold = [] (there is no top-level
  // Main) and `all` = the full union — never a bogus top-level "Main".
  const topLevel = scope.kind === "all";
  return {
    main: topLevel ? [] : active, // FR-2.1 Main == All only in-collection
    all: active, // in-collection == main; top-level = union
    buy: scopedWants.filter((w) => w.intent === "BUY"),
    sell: scopedWants.filter((w) => w.intent === "SELL"),
    sold: topLevel ? [] : sold, // Sold is per-collection (FR-5)
  };
}
