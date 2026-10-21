/**
 * Shared collection-payload shaping (G1).
 *
 * The authenticated collection GET route and the dashboard SSR page BOTH need
 * to turn raw `UserCollection` rows into the client payload shape where each
 * `card` exposes `gradedPrices` — the priced CurrentPrice rows PLUS the
 * history-fallback entry for a graded company+grade that has no current row.
 * Previously only the route did this; the SSR page selected a narrower shape,
 * so `initialItems` (React-Query `initialData`) lacked `gradedPrices` and
 * graded lots were valued by the coarse multiplier fallback on first paint
 * until the client refetch resolved.
 *
 * Centralizing the select fragment + the shaping here is the ONE source of
 * truth so the two surfaces cannot drift again. Pure w.r.t. Prisma: the caller
 * supplies the history-row fetcher, so this module stays unit-testable with no
 * DB import.
 */

import { parseGradedCondition, pickGradedRow } from "./raw-price";

/**
 * The `currentPrices` select both callers use on the card relation. Bounded by
 * `priceMarket != null`; carries `type`/`company`/`grade`/`variant`/`condition`
 * so `pickGradedFromRows → pickGradedVariant` can resolve the graded variant
 * from the GRADED MATCHES THEMSELVES (RAW-independent), matching the chart.
 */
export const COLLECTION_CARD_PRICE_SELECT = {
  where: { priceMarket: { not: null } },
  select: { type: true, company: true, grade: true, variant: true, condition: true, priceMarket: true },
} as const;

/** A CurrentPrice row as selected by COLLECTION_CARD_PRICE_SELECT. */
export interface CurrentPriceRow {
  type?: string | null;
  company?: string | null;
  grade?: string | null;
  variant?: string | null;
  condition?: string | null;
  priceMarket?: number | null;
}

/** A PricingHistory graded row used for the missing-current-grade fallback. */
export interface HistoryGradedRow {
  cardId: string;
  type?: string | null;
  company?: string | null;
  grade?: string | null;
  variant?: string | null;
  condition?: string | null;
  priceMarket?: number | null;
}

/** A graded company+grade a lot needs a historical fallback for. */
export interface FallbackNeed {
  cardId: string;
  company: string;
  grade: string;
}

/** The minimal item shape this module reads/writes: a `condition` + a `card`
 *  carrying `currentPrices` (selected rows). Generic over the rest of the item
 *  so both the route row and the SSR row satisfy it without a cast. */
type ItemWithCurrentPrices<C extends { currentPrices?: CurrentPriceRow[] | null }> = {
  cardId: string;
  condition?: string | null;
  card: C;
};

/**
 * A current row counts as graded for this company+grade when (type defaulting
 * to "graded" for legacy rows matching `pickRealGradedPrice`) company+grade
 * match and priceMarket is present — the SAME shape the display path treats as
 * a current match, so detection and valuation agree.
 */
export function currentHasGrade(
  rows: ReadonlyArray<CurrentPriceRow> | null | undefined,
  company: string,
  grade: string
): boolean {
  return (rows ?? []).some(
    (r) =>
      (r.type ?? "graded") === "graded" &&
      (r.company ?? "").toUpperCase() === company &&
      (r.grade ?? "") === grade &&
      r.priceMarket != null
  );
}

/**
 * The graded (company, grade) pairs whose lots have NO matching current row —
 * i.e. the set that needs a historical fallback. Callers turn the distinct
 * `cardId`s into one bounded `PricingHistory` read.
 */
export function collectFallbackNeeds<C extends { currentPrices?: CurrentPriceRow[] | null }>(
  items: ReadonlyArray<ItemWithCurrentPrices<C>>
): FallbackNeed[] {
  return items
    .map((it) => {
      const parsed = parseGradedCondition(it.condition);
      if (!parsed) return null;
      const company = parsed.company.toUpperCase();
      if (currentHasGrade(it.card.currentPrices, company, parsed.grade)) return null;
      return { cardId: it.cardId, company, grade: parsed.grade };
    })
    .filter((x): x is FallbackNeed => x != null);
}

/** Index the fetched historical graded rows by cardId (company uppercased). */
export function indexFallbackRows(
  histRows: ReadonlyArray<HistoryGradedRow>
): Map<string, HistoryGradedRow[]> {
  const map = new Map<string, HistoryGradedRow[]>();
  for (const r of histRows) {
    const arr = map.get(r.cardId) ?? [];
    arr.push({ ...r, company: r.company == null ? r.company : r.company.toUpperCase() });
    map.set(r.cardId, arr);
  }
  return map;
}

/**
 * Replace each item's `card.currentPrices` with `card.gradedPrices` — the full
 * priced set PLUS a history-fallback entry (variant/condition preserved,
 * `source:"history"`) for a graded lot the current snapshot can't price. A
 * raw/ungraded card keeps `currentPrices` as-is → `gradedPrices` undefined when
 * the select didn't populate it, so displayPrice falls back exactly as before.
 */
export function shapeGradedPrices<C extends { currentPrices?: CurrentPriceRow[] | null }>(
  items: ReadonlyArray<ItemWithCurrentPrices<C>>,
  fallbackByCard: Map<string, HistoryGradedRow[]>
) {
  return items.map((it) => {
    const { currentPrices, ...card } = it.card as C & { currentPrices?: CurrentPriceRow[] | null };
    let fallbackEntry: Record<string, unknown> | null = null;
    const parsed = parseGradedCondition(it.condition);
    if (parsed) {
      const company = parsed.company.toUpperCase();
      if (!currentHasGrade(currentPrices, company, parsed.grade)) {
        const pick = pickGradedRow(fallbackByCard.get(it.cardId) ?? [], company, parsed.grade);
        if (pick) {
          fallbackEntry = {
            type: "graded",
            company,
            grade: parsed.grade,
            variant: pick.variant, // the REAL historical row's variant
            condition: pick.condition, // the REAL historical row's condition
            priceMarket: pick.price,
            source: "history", // provenance marker (current rows have no source)
          };
        }
      }
    }
    // Preserve the prior contract: no current rows AND no fallback → leave
    // `gradedPrices` as whatever `currentPrices` was (undefined when unselected)
    // so the payload shape is unchanged.
    const gradedPrices =
      fallbackEntry != null ? [...(currentPrices ?? []), fallbackEntry] : currentPrices;
    return { ...it, card: { ...card, gradedPrices } };
  });
}
