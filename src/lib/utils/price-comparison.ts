/**
 * Price comparison helpers for the eBay Deal Finder feature.
 *
 * Compares the card's internal market value (from `Card.marketPrice`,
 * sourced from TCGplayer or apitcg) against a live eBay listing price
 * to decide whether the eBay listing is a "good deal" worth flagging
 * with a badge in the UI.
 *
 * The 10% threshold is a product decision, not a market signal —
 * anything smaller is likely noise (listing fees, shipping variance,
 * condition mismatch). Change `GOOD_DEAL_THRESHOLD` in one place if
 * the client wants a different bar.
 */

/** Percentage below marketPrice that counts as a good deal. */
export const GOOD_DEAL_THRESHOLD = 0.10;

export interface DealEvaluation {
  /** True when the eBay price is at least GOOD_DEAL_THRESHOLD below market. */
  isGoodDeal: boolean;
  /** USD savings (marketPrice - ebayPrice). Non-negative only when isGoodDeal. */
  savings: number;
  /** Ratio saved (0.15 = 15% off). Non-negative only when isGoodDeal. */
  savingsPct: number;
}

/**
 * Compares an eBay listing price against our recorded market price.
 *
 * @param marketPrice The card's recorded market value in USD. Must be a
 *   positive number; anything zero/negative/NaN is treated as "no data"
 *   and returns `{ isGoodDeal: false }`.
 * @param ebayPrice The eBay listing's asking price in USD. Same guards.
 * @returns The evaluation result. Callers should render the "🔥 Good
 *   Deal" badge only when `isGoodDeal` is true.
 *
 * @example
 * evaluateDeal(100, 85)  // → { isGoodDeal: true,  savings: 15, savingsPct: 0.15 }
 * evaluateDeal(100, 95)  // → { isGoodDeal: false, savings: 0,  savingsPct: 0 }
 * evaluateDeal(0, 50)    // → { isGoodDeal: false, savings: 0,  savingsPct: 0 }
 */
export function evaluateDeal(
  marketPrice: number,
  ebayPrice: number
): DealEvaluation {
  if (!Number.isFinite(marketPrice) || marketPrice <= 0) {
    return { isGoodDeal: false, savings: 0, savingsPct: 0 };
  }
  if (!Number.isFinite(ebayPrice) || ebayPrice <= 0) {
    return { isGoodDeal: false, savings: 0, savingsPct: 0 };
  }

  const savings = marketPrice - ebayPrice;
  const savingsPct = savings / marketPrice;

  if (savingsPct >= GOOD_DEAL_THRESHOLD) {
    return { isGoodDeal: true, savings, savingsPct };
  }
  return { isGoodDeal: false, savings: 0, savingsPct: 0 };
}

/**
 * Computes the average price across an array of eBay listings.
 *
 * Useful because the Browse API returns 3 individual listings — a
 * simple mean is a reasonable proxy for "current eBay asking price"
 * without weighting by shipping/condition (which we don't have).
 *
 * @param prices Array of positive listing prices in USD.
 * @returns The arithmetic mean, or `null` when the array is empty or
 *   contains no positive numbers.
 */
export function averageEbayPrice(prices: number[]): number | null {
  const valid = prices.filter((p) => Number.isFinite(p) && p > 0);
  if (valid.length === 0) return null;
  const sum = valid.reduce((acc, p) => acc + p, 0);
  return sum / valid.length;
}

/**
 * Builds the direct-to-eBay search URL for a card name (+ optional
 * set name). Used by the "Find on eBay ›" link when we don't have any
 * cached listings, or as a fallback when the eBay API is in sandbox
 * mode and returns 0 results.
 *
 * Uses eBay's classic HTML search endpoint (not the Browse API) since
 * we're linking a real user to a real browser page, not making a
 * programmatic call.
 */
export function buildEbaySearchUrl(name: string, setName?: string): string {
  const q = setName ? `${name} ${setName}` : name;
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q.trim())}`;
}
