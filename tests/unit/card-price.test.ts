import { describe, it, expect } from "vitest";
import { pickPokemonMarketPrice } from "@/lib/utils/card-price";

/**
 * Guards the Pokémon price-picking rule shared by the sync and the on-demand
 * reprice route — the logic behind newest-set cards no longer showing "—"
 * once a price exists at either source.
 */
describe("pickPokemonMarketPrice", () => {
  it("prefers the first TCGplayer variant with a market price", () => {
    expect(
      pickPokemonMarketPrice({ tcgplayer: { prices: { holofoil: { market: 12.5 } } } })
    ).toBe(12.5);
  });

  it("skips variants with no market and takes the next", () => {
    expect(
      pickPokemonMarketPrice({
        tcgplayer: { prices: { normal: {}, reverseHolofoil: { market: 3.25 } } },
      })
    ).toBe(3.25);
  });

  it("falls back to Cardmarket when TCGplayer has no market (new sets)", () => {
    expect(
      pickPokemonMarketPrice({
        tcgplayer: { prices: { normal: {} } },
        cardmarket: { prices: { averageSellPrice: 8.4, trendPrice: 9 } },
      })
    ).toBe(8.4);
  });

  it("uses trendPrice/avg when averageSellPrice is absent", () => {
    expect(pickPokemonMarketPrice({ cardmarket: { prices: { trendPrice: 5 } } })).toBe(5);
    expect(pickPokemonMarketPrice({ cardmarket: { prices: { avg7: 4.1 } } })).toBe(4.1);
  });

  it("returns null when no usable price exists anywhere", () => {
    expect(pickPokemonMarketPrice({})).toBeNull();
    expect(pickPokemonMarketPrice({ tcgplayer: { prices: {} }, cardmarket: { prices: {} } })).toBeNull();
    expect(pickPokemonMarketPrice({ cardmarket: { prices: { averageSellPrice: 0 } } })).toBeNull();
  });
});
