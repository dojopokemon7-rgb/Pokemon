/**
 * Dual-scoped "All" resolver (F-#8, design §4).
 *
 * A single pure helper centralizes the collection `where` so routes and the
 * dashboard can never disagree about what "All" / "Main" / loose means. Pure
 * and client-safe: returns plain objects, no Prisma import, no I/O.
 *
 * The codebase already has TWO distinct all-constants and the dashboard emits
 * NEITHER as a selection:
 *   - ALL_VIEW_ID = "__all__"      — the reserved id of the read-only VIRTUAL
 *     collection the collections service refuses to write (assertNotVirtual).
 *   - ALL_COLLECTIONS = "all"      — the sentinel the AGGREGATOR accepts to mean
 *     "sum across everything".
 *   - the DASHBOARD represents top-level All as `selectedIds.size === 0` and
 *     passes `null`; it has no "__all__" option.
 * All three all-signals collapse to {kind:"all"} so no caller can diverge.
 */

import { ALL_VIEW_ID } from "@/lib/utils/collections-virtual";
import { ALL_COLLECTIONS } from "@/lib/utils/collection-aggregation";

/** The three scope kinds a collection view can request. */
export type CollectionScope =
  | { kind: "all" } // top-level All: union across everything
  | { kind: "collection"; id: string } // a specific named collection
  | { kind: "loose" }; // the loose/Main set (collectionId == null)

/**
 * Parse a UI/API selection id into a scope.
 *   null | undefined | "" | ALL_VIEW_ID ("__all__") | ALL_COLLECTIONS ("all") → top-level All
 *   "__uncat__"                                                               → loose/Main
 *   any other id                                                              → that collection
 */
export function toScope(selectionId: string | null | undefined): CollectionScope {
  if (!selectionId || selectionId === ALL_VIEW_ID || selectionId === ALL_COLLECTIONS)
    return { kind: "all" };
  if (selectionId === "__uncat__") return { kind: "loose" };
  return { kind: "collection", id: selectionId };
}

/** Prisma `where` fragment for the ACTIVE (Main == in-collection All) set. */
export function activeWhere(userId: string, scope: CollectionScope) {
  const base = { userId, isSold: false as const };
  if (scope.kind === "all") return base; // FR-3.1 top-level
  if (scope.kind === "loose") return { ...base, collectionId: null };
  return { ...base, collectionId: scope.id }; // FR-2.1 / FR-3.1 in-collection
}

/** Prisma `where` fragment for the SOLD set at the same scope (FR-5). */
export function soldWhere(userId: string, scope: CollectionScope) {
  const base = { userId, isSold: true as const };
  if (scope.kind === "all") return base;
  if (scope.kind === "loose") return { ...base, collectionId: null };
  return { ...base, collectionId: scope.id };
}
