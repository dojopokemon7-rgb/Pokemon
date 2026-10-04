/**
 * collection-ids — pure, client- AND server-safe (no secrets, no Prisma) token
 * translation between the dashboard selector's bucket ids and the
 * collection-history service's token vocabulary.
 *
 * WHY (dashboard-chart key-path fix): the UI selector pushes the loose/
 * uncategorized bucket with the sentinel id "__uncat__", but
 * buildCollectionHistories only understands "null" (collectionId IS NULL),
 * "all" (no filter), or a literal collectionId cuid. Sending "__uncat__"
 * verbatim filters `collectionId = "__uncat__"`, matches zero rows, and the
 * loose bucket never plots. Translating "__uncat__" → "null" at the two call
 * sites (client fetch + SSR page) via this ONE shared helper keeps both paths
 * from drifting (the shared-function discipline this codebase relies on).
 */

/** UI selector sentinel for the loose/uncategorized bucket. */
export const UNCAT_ID = "__uncat__";

/** Map a UI selector id to the history-service token: the loose-cards bucket
 *  "__uncat__" → the service's "null" (collectionId IS NULL); every other id
 *  (named-collection cuid, or "all") passes through unchanged. */
export function toHistoryToken(selectorId: string): string {
  return selectorId === UNCAT_ID ? "null" : selectorId;
}
