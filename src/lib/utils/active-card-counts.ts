/**
 * Active owned-card counts for the You page "Cards" / "Graded" stats (QA #4).
 *
 * GET /api/users/me/collection returns SOLD lots (isSold=true) alongside active
 * ones. The You page counts must reflect what the user still OWNS, so sold lots
 * are excluded here — the same honesty contract statsFromLots applies to the
 * Paid/Value split. Previously these were summed over ALL rows, so a sold lot
 * inflated "Cards" (and "Graded").
 */

import { isGraded } from "./graded-price";

/** Minimal shape needed to count active owned cards. */
export interface CountLot {
  quantity: number;
  condition: string | null;
  isSold?: boolean;
}

/**
 * Sums quantities over ACTIVE lots only. `graded` further restricts to lots whose
 * free-text condition names a grading company (same heuristic the add flow uses).
 *
 * ponytail: graded is a heuristic count (regex on free-text condition) — upgrade
 * path is a dedicated grading schema on UserCollection.
 */
export function activeCardCounts(lots: CountLot[]): { totalCards: number; graded: number } {
  let totalCards = 0;
  let graded = 0;
  for (const lot of lots) {
    if (lot.isSold) continue;
    const qty = lot.quantity ?? 0;
    totalCards += qty;
    if (isGraded(lot.condition)) graded += qty;
  }
  return { totalCards, graded };
}
