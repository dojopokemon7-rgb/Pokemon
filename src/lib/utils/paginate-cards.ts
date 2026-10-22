/**
 * Pure client-side helpers for offset-paginated card grids (audit 02 F-T).
 *
 * Both the trending grid and the search results grid use TanStack
 * `useInfiniteQuery` and need the SAME two things: flatten all loaded pages
 * into one list while de-duplicating by the card's catalog identity (so a card
 * can never render twice if a curated page 1 and a later catalog page overlap —
 * F-04), and translate a page's numeric `nextCursor` into the `pageParam` the
 * query expects (`null` → `undefined`, meaning "no further page").
 *
 * These live in src/lib (NOT a named export from search/page.tsx — the Next
 * Page-type phase rejects any non-default export there) and are generic +
 * dependency-free so both grids share one unit-tested implementation.
 *
 * NOTE (AGENTS.md RULE 3 — two card ids): trending items carry an explicit
 * `externalId`; search results carry the catalog id as `id`. The caller picks
 * which field is the dedupe identity via `keyOf`, so neither grid has to
 * reshape its items.
 */

/** A single page of a paginated cards response. */
export interface CardsPage<T> {
  cards: T[];
}

/** A page carrying the offset-pagination next-page cursor. */
export interface PagedResponse {
  nextCursor: number | null;
}

/**
 * Flatten paginated pages into one list, keeping only the FIRST occurrence of
 * each item (by `keyOf`) in page/item order. Empty / missing pages → [].
 */
export function flattenDedupe<T>(
  pages: CardsPage<T>[] | undefined,
  keyOf: (item: T) => string
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const page of pages ?? []) {
    for (const item of page.cards) {
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/**
 * TanStack `getNextPageParam`: a numeric `nextCursor` is the next page's
 * offset; `null` means no further page, which TanStack signals as `undefined`.
 */
export function getNextCursorParam(lastPage: PagedResponse): number | undefined {
  return lastPage.nextCursor ?? undefined;
}
