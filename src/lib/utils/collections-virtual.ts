/**
 * Virtual "ALL" collection view (plan §6).
 *
 * ALL is a built-in, NON-EDITABLE view that aggregates every owned card —
 * including cards not assigned to any named collection (collectionId null). It
 * is synthesized in the query/selector layer, not stored, and carries a
 * reserved id so the collections API can refuse any write that targets it
 * (rename / delete / settings), which would otherwise be nonsensical.
 */

export const ALL_VIEW_ID = "__all__";
export const ALL_VIEW_NAME = "All Cards";

/** True when an id refers to the reserved virtual ALL view. */
export function isVirtualCollectionId(id: string | null | undefined): boolean {
  return id === ALL_VIEW_ID;
}
