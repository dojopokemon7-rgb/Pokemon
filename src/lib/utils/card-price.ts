/**
 * Pokémon price extraction from a pokemontcg.io card payload.
 *
 * Shared by the daily sync and the on-demand /api/cards/reprice route so the
 * price-picking rule lives in exactly one place. Preference order:
 *   1. TCGplayer market price (first variant that has one)
 *   2. Cardmarket fallback — new sets often price here before TCGplayer
 *      (averageSellPrice → trendPrice → avg7 → avg30)
 * Returns null when neither source has a usable positive number.
 */

export interface PokemonPricePayload {
  tcgplayer?: { prices?: Record<string, { market?: number } | undefined> };
  cardmarket?: {
    prices?: {
      averageSellPrice?: number;
      trendPrice?: number;
      avg7?: number;
      avg30?: number;
    };
  };
}

export function pickPokemonMarketPrice(card: PokemonPricePayload): number | null {
  const tcg = card.tcgplayer?.prices;
  if (tcg) {
    for (const v of Object.values(tcg)) {
      if (v && typeof v.market === "number" && !Number.isNaN(v.market) && v.market > 0) {
        return v.market;
      }
    }
  }
  const cm = card.cardmarket?.prices;
  for (const v of [cm?.averageSellPrice, cm?.trendPrice, cm?.avg7, cm?.avg30]) {
    if (typeof v === "number" && !Number.isNaN(v) && v > 0) return v;
  }
  return null;
}
