import { describe, it, expect } from "vitest";
import {
  variantHeroSrc,
  cardImgById,
  onePieceImageUrl,
  HERO_PLACEHOLDER,
} from "@/lib/utils/card-image";

/**
 * Bug #6 — the card-detail HERO image must FOLLOW the selected variant.
 *
 * Per-printing rows each carry their own imageUrl keyed by the composite
 * externalId `${baseId}::${variant}` (RULE 3). variantHeroSrc resolves a
 * NON-DEFAULT variant through the game-agnostic id-proxy (cardImgById) with
 * that composite id — serving THAT printing's art for BOTH Pokémon and One
 * Piece — and keeps the base-art behavior (Bandai proxy / id-proxy) otherwise.
 * A printing with no distinct stored image 404s and the page's onError degrades
 * to HERO_PLACEHOLDER (never a broken image, RULE 2).
 */
describe("variantHeroSrc", () => {
  it("keeps base art when the selected variant equals the default (Pokémon)", () => {
    expect(
      variantHeroSrc({
        game: "pokemon",
        routeId: "base1-4",
        variant: "holofoil",
        defaultVariant: "holofoil",
      })
    ).toBe(cardImgById("base1-4"));
  });

  it("resolves a non-default Pokémon variant via the composite-id proxy", () => {
    expect(
      variantHeroSrc({
        game: "pokemon",
        routeId: "base1-4",
        variant: "reverse holofoil",
        defaultVariant: "holofoil",
      })
    ).toBe(cardImgById("base1-4::reverse holofoil"));
  });

  it("keeps the Bandai base-art proxy for a One Piece base variant", () => {
    expect(
      variantHeroSrc({
        game: "onepiece",
        routeId: "OP01-120",
        variant: "normal",
        defaultVariant: "normal",
      })
    ).toBe(onePieceImageUrl("OP01-120"));
  });

  it("resolves a non-default One Piece variant via the per-printing proxy (NOT the Bandai base proxy)", () => {
    const src = variantHeroSrc({
      game: "onepiece",
      routeId: "OP01-120",
      variant: "alt-art",
      defaultVariant: "normal",
    });
    expect(src).toBe(cardImgById("OP01-120::alt-art"));
    expect(src).not.toBe(onePieceImageUrl("OP01-120"));
  });

  it("re-selects off the base of a composite ROUTE id", () => {
    // A composite route id whose selected variant equals its own suffix → base.
    expect(
      variantHeroSrc({
        game: "pokemon",
        routeId: "base1-15::unlimitedShadowlessHolofoil",
        variant: "unlimitedShadowlessHolofoil",
        defaultVariant: "unlimitedShadowlessHolofoil",
      })
    ).toBe(cardImgById("base1-15::unlimitedShadowlessHolofoil"));

    // Selecting a DIFFERENT variant resolves off the stripped base id.
    expect(
      variantHeroSrc({
        game: "pokemon",
        routeId: "base1-15::unlimitedShadowlessHolofoil",
        variant: "reverse holofoil",
        defaultVariant: "unlimitedShadowlessHolofoil",
      })
    ).toBe(cardImgById("base1-15::reverse holofoil"));
  });

  it("falls back to base art for a null variant (both games)", () => {
    expect(
      variantHeroSrc({ game: "pokemon", routeId: "base1-4", variant: null, defaultVariant: "holofoil" })
    ).toBe(cardImgById("base1-4"));
    expect(
      variantHeroSrc({ game: "onepiece", routeId: "OP01-120", variant: null, defaultVariant: "normal" })
    ).toBe(onePieceImageUrl("OP01-120"));
  });

  it("falls back to HERO_PLACEHOLDER for a One Piece base with a non-Bandai code", () => {
    // A non-Bandai id on the One Piece branch (no proxy url) → placeholder.
    expect(
      variantHeroSrc({ game: "onepiece", routeId: "not-a-code", variant: null, defaultVariant: null })
    ).toBe(HERO_PLACEHOLDER);
  });
});
