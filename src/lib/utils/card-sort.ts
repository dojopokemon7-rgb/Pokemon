/**
 * Shared sort options for card lists — used by both /api/cards/search
 * and /api/cards/trending so a single SortKey drives both surfaces.
 * The client's filter sheet references the same key set.
 */

import type { Prisma } from "@prisma/client";
import { z } from "zod";

export const CardSortEnum = z.enum([
  "trending",
  "market_desc",
  "market_asc",
  "name_asc",
  "recent",
  // Weekly price change (plan §4). Sorts by the stored real 7-day delta;
  // daily/monthly are intentionally deferred.
  "week_change_desc",
  "week_change_asc",
  "week_pct_desc",
  "week_pct_asc",
]);
export type CardSortKey = z.infer<typeof CardSortEnum>;

/** Human-readable labels shared with the client filter sheet.
 *  `trending` = real "hot right now" (most collection-adds in the last
 *  N days — computed in the trending route, not a plain orderBy).
 *  `recent` = most recently synced (updatedAt desc). */
export const CARD_SORT_LABELS: Record<CardSortKey, string> = {
  trending: "Trending",
  market_desc: "Price · High to Low",
  market_asc: "Price · Low to High",
  name_asc: "Name · A to Z",
  recent: "Recently Added",
  week_change_desc: "Weekly Change · High to Low",
  week_change_asc: "Weekly Change · Low to High",
  week_pct_desc: "Weekly % · High to Low",
  week_pct_asc: "Weekly % · Low to High",
};

/**
 * Builds the Prisma orderBy for the requested sort. `market_desc`
 * matches the pre-existing default for /api/cards/search;
 * /api/cards/trending's historical default (`updatedAt desc`) is
 * exposed as `recent`.
 */
export function orderByForCardSort(
  sort: CardSortKey
): Prisma.CardOrderByWithRelationInput[] {
  switch (sort) {
    case "market_asc":
      return [{ marketPrice: { sort: "asc", nulls: "last" } }, { name: "asc" }];
    case "name_asc":
      return [{ name: "asc" }];
    case "week_change_desc":
      return [{ weeklyChangeAbs: { sort: "desc", nulls: "last" } }, { name: "asc" }];
    case "week_change_asc":
      return [{ weeklyChangeAbs: { sort: "asc", nulls: "last" } }, { name: "asc" }];
    case "week_pct_desc":
      return [{ weeklyChangePct: { sort: "desc", nulls: "last" } }, { name: "asc" }];
    case "week_pct_asc":
      return [{ weeklyChangePct: { sort: "asc", nulls: "last" } }, { name: "asc" }];
    // `trending` can't be expressed as a plain Card orderBy (it ranks by
    // collection-add counts — see the trending route). This fallback is
    // only used for cards with no recent adds, and for /api/cards/search
    // which doesn't compute the popularity ranking: newest-synced first.
    case "trending":
    case "recent":
      return [{ updatedAt: "desc" }];
    case "market_desc":
    default:
      return [{ marketPrice: { sort: "desc", nulls: "last" } }, { name: "asc" }];
  }
}
