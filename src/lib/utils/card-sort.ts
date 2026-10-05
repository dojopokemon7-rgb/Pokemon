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
  week_change_desc: "7-day change ($) · High to Low",
  week_change_asc: "7-day change ($) · Low to High",
  week_pct_desc: "7-day change (%) · High to Low",
  week_pct_asc: "7-day change (%) · Low to High",
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

export const WEEK_SORT_KEYS = [
  "week_change_desc",
  "week_change_asc",
  "week_pct_desc",
  "week_pct_asc",
] as const;
export type WeekSortKey = (typeof WEEK_SORT_KEYS)[number];

/**
 * In-memory twin of the DB week_* orderBy, for lists not DB-sorted (the
 * portfolio). Reads ONLY the stored Card.weeklyChangeAbs/Pct (Scrydex
 * trends.days_7) via `pick` — never chart/synthetic data. Null, undefined,
 * non-finite (zero-baseline NaN/Infinity) and `isUsable === false` (stale)
 * rows go last; ties and nulls keep input order. Returns a new array.
 * ponytail: no per-row staleness column exists (no Card.weeklyChangeAt), so
 * callers can't yet pass a real isUsable; upgrade when that column lands.
 */
export function sortByWeeklyChange<T>(
  items: readonly T[],
  key: WeekSortKey,
  pick: (item: T) => { weeklyChangeAbs?: number | null; weeklyChangePct?: number | null },
  isUsable: (item: T) => boolean = () => true
): T[] {
  const field = key.startsWith("week_pct") ? "weeklyChangePct" : "weeklyChangeAbs";
  const dir = key.endsWith("_desc") ? -1 : 1;
  const val = (item: T): number | null => {
    if (!isUsable(item)) return null;
    const v = pick(item)[field];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  return items
    .map((item, i) => ({ item, i, v: val(item) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : a.v === null ? 1 : -1;
      return (a.v - b.v) * dir || a.i - b.i;
    })
    .map((x) => x.item);
}