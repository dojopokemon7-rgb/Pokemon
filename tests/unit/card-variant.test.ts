import { describe, it, expect } from "vitest";
import {
  variantKey,
  variantSpellings,
  variantDisplayLabel,
  parseVariantFromQuery,
  resolveInferredVariants,
} from "@/lib/utils/card-variant";

describe("variantKey / spellings / label", () => {
  it("collapses every real Scrydex spelling to one key", () => {
    for (const raw of ["reverseHolofoil", "reverse holofoil", "Reverse-Holofoil", "REVERSE_HOLOFOIL"]) {
      expect(variantKey(raw)).toBe("reverse holofoil");
    }
    expect(variantKey("altArt")).toBe("alt art");
    expect(variantKey("alt-art")).toBe("alt art");
    expect(variantKey("1stEditionHolofoil")).toBe("first edition holofoil");
    expect(variantKey("firstEditionHolofoil")).toBe("first edition holofoil");
    expect(variantKey("unlimitedShadowlessHolofoil")).toBe("unlimited shadowless holofoil");
    expect(variantKey("  ")).toBe("");
  });

  it("spellings cover space, hyphen, underscore, joined (= camelCase insensitively) and 1st", () => {
    const s = variantSpellings("first edition holofoil");
    expect(s).toEqual(
      expect.arrayContaining([
        "first edition holofoil",
        "first-edition-holofoil",
        "first_edition_holofoil",
        "firsteditionholofoil",
        "1st edition holofoil",
        "1steditionholofoil",
      ])
    );
    expect(variantSpellings("alt art")).toContain("altart");
    expect(variantSpellings("")).toEqual([]);
  });

  it("maps raw values to friendly labels", () => {
    expect(variantDisplayLabel("reverseHolofoil")).toBe("Reverse Holo");
    expect(variantDisplayLabel("holofoil")).toBe("Holo");
    expect(variantDisplayLabel("normal")).toBe("Normal");
    expect(variantDisplayLabel("alt-art")).toBe("Alt Art");
    expect(variantDisplayLabel("1stEditionHolofoil")).toBe("1st Edition Holo");
    expect(variantDisplayLabel("unlimitedShadowlessHolofoil")).toBe("Unlimited Shadowless Holo");
  });
});

describe("parseVariantFromQuery", () => {
  it.each([
    ["charizard reverse holo", "charizard", "reverse holofoil"],
    ["charizard reverse holofoil", "charizard", "reverse holofoil"],
    ["charizard rev holo", "charizard", "reverse holofoil"],
    ["charizard reverse foil", "charizard", "reverse holofoil"],
    ["charizard holo", "charizard", "holofoil"],
    ["charizard holofoil", "charizard", "holofoil"],
    ["luffy alt art", "luffy", "alt art"],
    ["luffy alternate art", "luffy", "alt art"],
    ["luffy alt-art", "luffy", "alt art"],
    ["charizard 1st edition", "charizard", "first edition"],
    ["charizard first edition", "charizard", "first edition"],
    ["charizard 1st ed", "charizard", "first edition"],
    ["charizard 1st edition holo", "charizard", "first edition holofoil"],
    ["charizard first edition holofoil", "charizard", "first edition holofoil"],
    ["luffy foil", "luffy", "foil"],
  ])("%s -> %s + %s", (q, rest, variant) => {
    expect(parseVariantFromQuery(q)).toEqual({ query: rest, variant });
  });

  it("is case/whitespace/punctuation tolerant and works mid-query", () => {
    expect(parseVariantFromQuery("  Charizard   REVERSE   Holo  ")).toEqual({
      query: "Charizard",
      variant: "reverse holofoil",
    });
    expect(parseVariantFromQuery("reverse holo charizard ex")).toEqual({
      query: "charizard ex",
      variant: "reverse holofoil",
    });
    expect(parseVariantFromQuery("charizard, holo!")).toEqual({ query: "charizard,", variant: "holofoil" });
  });

  it("longest phrase wins (reverse holo is not holo)", () => {
    expect(parseVariantFromQuery("pikachu reverse holo").variant).toBe("reverse holofoil");
    expect(parseVariantFromQuery("pikachu 1st edition holo").variant).toBe("first edition holofoil");
  });

  it("variant-only query is left as plain text", () => {
    for (const q of ["holo", "reverse holo", "alt art", "1st edition", "  foil "]) {
      expect(parseVariantFromQuery(q)).toEqual({ query: q.trim(), variant: null });
    }
  });

  it("rarity names and look-alike words are not variants", () => {
    expect(parseVariantFromQuery("charizard rare holo").variant).toBeNull();
    expect(parseVariantFromQuery("holo rare charizard").variant).toBeNull();
    expect(parseVariantFromQuery("holographic charizard").variant).toBeNull();
    expect(parseVariantFromQuery("foiled charizard").variant).toBeNull();
    expect(parseVariantFromQuery("altart charizard").variant).toBe("alt art");
    expect(parseVariantFromQuery("alt charizard").variant).toBeNull();
    expect(parseVariantFromQuery("normal charizard").variant).toBeNull();
    expect(parseVariantFromQuery("charizard").variant).toBeNull();
    expect(parseVariantFromQuery("").variant).toBeNull();
  });
});

describe("resolveInferredVariants", () => {
  const avail = ["alt art", "first edition holofoil", "first edition shadowless holofoil", "holofoil", "normal"];
  it("exact match only, except first edition covers its holo siblings", () => {
    expect(resolveInferredVariants("holofoil", avail)).toEqual(["holofoil"]);
    expect(resolveInferredVariants("first edition", avail)).toEqual([
      "first edition holofoil",
      "first edition shadowless holofoil",
    ]);
  });
  it("nothing when the game has no such printing (no printing data)", () => {
    expect(resolveInferredVariants("reverse holofoil", avail)).toEqual([]);
    expect(resolveInferredVariants("holofoil", [])).toEqual([]);
  });
});
