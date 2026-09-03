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
 * Kept for anywhere that still wants a mean, but the price-comparison
 * panel itself now uses {@link lowestEbayPrice} — an average across
 * multiple listings hides the actual purchasable price of the card.
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
 * Returns the lowest asking price across the supplied eBay listings.
 *
 * This is the number the buyer actually cares about: "what would I pay
 * for this card on eBay right now?" — not an average, which blends
 * outliers, and not the highest, which is the worst offer available.
 *
 * @param prices Array of listing prices in USD.
 * @returns The minimum positive finite price, or `null` when the array
 *   contains no usable prices.
 */
export function lowestEbayPrice(prices: number[]): number | null {
  let min: number | null = null;
  for (const p of prices) {
    if (!Number.isFinite(p) || p <= 0) continue;
    if (min == null || p < min) min = p;
  }
  return min;
}

// Bandai One Piece card code pattern — OP01-001, ST01-005, EB01-023, etc.
// Sellers include these codes verbatim in listing titles, so appending
// them to an eBay search DRAMATICALLY narrows results to the exact card
// (e.g. `Luffy OP01-001` → ~50 hits vs `Luffy` → 100k+ hits).
const BANDAI_CODE_PATTERN = /^(OP|ST|EB|PRB)\d{2}-\d{3}$/i;

/**
 * Builds a targeted eBay HTML search URL for a card. The narrowing
 * strategy depends on what identifiers we have available:
 *
 *   1. If `cardCode` matches a Bandai One Piece pattern (e.g.
 *      "OP01-001"), that alone plus the name gives the tightest search.
 *   2. Otherwise fall back to name + setName, which is decent for
 *      Pokemon since set names ("Base Set", "Evolving Skies") are
 *      human-searchable, but does nothing useful for tcgdex-style
 *      internal ids like `pl4-1` which no seller ever puts in a title.
 *
 * @param name      Card name — always included.
 * @param setName   Optional human-readable set name (e.g. "Base Set").
 * @param cardCode  Optional card code — included only if it's a
 *                  Bandai-style code that sellers actually use.
 */
export function buildEbaySearchUrl(
  name: string,
  setName?: string,
  cardCode?: string
): string {
  const parts: string[] = [name];
  if (cardCode && BANDAI_CODE_PATTERN.test(cardCode.trim())) {
    parts.push(cardCode.trim().toUpperCase());
  } else if (setName) {
    parts.push(setName);
  }
  const q = parts.join(" ").trim();
  // `_sacat=2611` = eBay's "CCG Individual Cards" category. Restricting
  // the HTML search to this category filters out Pokemon GO / TCG
  // Pocket / digital-trade listings the same way the Browse API call
  // does — a keyword-only search for "Pikachu" otherwise returns
  // thousands of unrelated items.
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&_sacat=2611`;
}
