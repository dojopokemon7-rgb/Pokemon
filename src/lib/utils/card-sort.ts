/**
 * Shared sort options for card lists — used by both /api/cards/search
 * and /api/cards/trending so a single SortKey drives both surfaces.
 * The client's filter sheet references the same key set.
 */

import type { Prisma } from "@prisma/client";
import { z } from "zod";

export const CardSortEnum = z.enum([
  "market_desc",
  "market_asc",
  "name_asc",
  "recent",
]);
export type CardSortKey = z.infer<typeof CardSortEnum>;

/** Human-readable labels shared with the client filter sheet. */
export const CARD_SORT_LABELS: Record<CardSortKey, string> = {
  market_desc: "Price · High to Low",
  market_asc: "Price · Low to High",
  name_asc: "Name · A to Z",
  recent: "Recently Added",
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
    case "recent":
      return [{ updatedAt: "desc" }];
    case "market_desc":
    default:
      return [{ marketPrice: { sort: "desc", nulls: "last" } }, { name: "asc" }];
  }
}
