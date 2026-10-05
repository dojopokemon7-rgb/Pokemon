/**
 * main-collection — pure, client- AND server-safe helpers for the protected
 * per-user "Main" collection (default destination for adds).
 *
 * The DB unique index on (userId, name) is case-SENSITIVE, so "Main" / "main" /
 * " MAIN " could otherwise coexist. Every Main check goes through this ONE
 * normalizer so lookup, create and protection agree.
 */
export const MAIN_COLLECTION_NAME = "Main";

/** True when `name` is "Main" ignoring case and surrounding whitespace. */
export function isMainCollectionName(name: string | null | undefined): boolean {
  return (name ?? "").trim().toLowerCase() === MAIN_COLLECTION_NAME.toLowerCase();
}
