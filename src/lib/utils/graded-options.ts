/**
 * graded-options — derive AddCardSheet's graded Grader options from the raw
 * `prices` rows returned by GET /api/cards/[id]/prices.
 *
 * This is the SINGLE source of truth for "turn stored CurrentPrice rows into the
 * {company, grade, price} list the AddCardSheet grader dropdown is built from".
 * The card-DETAIL page derived it inline; the Explore grid "+" now self-fetches
 * /prices from inside AddCardSheet and runs the SAME derivation here, so both
 * entry points offer the identical real graded graders (RULE 2 — never fabricate:
 * a company/grade is listed ONLY when a stored graded row exists; price is the
 * real stored value or null → "—").
 *
 * Pure + side-effect-free (AGENTS.md rule 11) — unit-tested in isolation.
 */

import type { GradedPriceEntry } from "@/components/AddCardSheet";

// A single current-price row as returned by /api/cards/[id]/prices. Only the
// fields this derivation reads are declared; extra columns flow through
// harmlessly. Mirrors CurrentPriceRow in search/[id]/price-history-chart.ts.
export interface PricesRow {
  company?: string | null;
  grade?: string | null;
  type?: string | null;
  priceMarket?: number | null;
  priceLow?: number | null;
}

/**
 * Map stored `/prices` rows → graded entries for AddCardSheet. Keeps only rows
 * that are graded AND carry both a company and a grade; company is uppercased,
 * grade verbatim, price = priceMarket ?? priceLow ?? null. Mirrors the detail
 * page's inline derivation exactly so a grid add equals a detail-page add.
 */
export function gradedOptionsFromPrices(
  rows: PricesRow[] | null | undefined
): GradedPriceEntry[] {
  if (!rows || rows.length === 0) return [];
  return rows
    .filter((p) => (p.type ?? "raw") === "graded" && p.company && p.grade)
    .map((p) => ({
      company: (p.company as string).toUpperCase(),
      grade: p.grade as string,
      price: p.priceMarket ?? p.priceLow ?? null,
    }));
}
