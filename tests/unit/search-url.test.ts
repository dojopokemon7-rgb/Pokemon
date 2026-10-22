import { describe, it, expect } from "vitest";
import { buildSearchUrl, buildSearchQueryParams, gameSwitchFilters } from "@/lib/utils/search-url";

/**
 * audit 02 F-A — pins that every active filter + a non-default sort survive a
 * new search / sort change / multi-link, and that a game switch keeps the
 * universal filters while dropping the per-game ones (set, rarity).
 */

describe("buildSearchUrl", () => {
  it("new search preserves every active filter + non-default sort alongside q+game", () => {
    const url = buildSearchUrl({
      q: "charizard",
      game: "pokemon",
      set: "Base",
      rarity: "Rare Holo",
      graded: "graded",
      minPrice: "10",
      maxPrice: "100",
      hasPrice: "true",
      language: "ja",
      sort: "market_desc",
    });
    const params = new URLSearchParams(url.split("?")[1]);
    expect(url.startsWith("/search?")).toBe(true);
    expect(params.get("q")).toBe("charizard");
    expect(params.get("game")).toBe("pokemon");
    expect(params.get("set")).toBe("Base");
    expect(params.get("rarity")).toBe("Rare Holo");
    expect(params.get("graded")).toBe("graded");
    expect(params.get("minPrice")).toBe("10");
    expect(params.get("maxPrice")).toBe("100");
    expect(params.get("hasPrice")).toBe("true");
    expect(params.get("language")).toBe("ja");
    expect(params.get("sort")).toBe("market_desc");
  });

  it("omits empty/undefined values and drops the default sort 'trending'", () => {
    const url = buildSearchUrl({
      q: "pikachu",
      game: "pokemon",
      set: "",
      rarity: undefined,
      graded: null,
      sort: "trending",
    });
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("q")).toBe("pikachu");
    expect(params.get("game")).toBe("pokemon");
    expect(params.has("set")).toBe(false);
    expect(params.has("rarity")).toBe(false);
    expect(params.has("graded")).toBe(false);
    expect(params.has("sort")).toBe(false);
  });

  it("returns bare /search when given no params (trending view)", () => {
    expect(buildSearchUrl({})).toBe("/search");
  });
});

describe("gameSwitchFilters", () => {
  it("keeps universal filters (+ q/sort) and drops set/rarity", () => {
    const next = gameSwitchFilters(
      {
        q: "ex",
        game: "pokemon",
        set: "Base",
        rarity: "Rare Holo",
        graded: "ungraded",
        minPrice: "5",
        maxPrice: "50",
        hasPrice: "true",
        language: "en",
        sort: "market_asc",
      },
      "onepiece"
    );
    expect(next.game).toBe("onepiece");
    expect(next.q).toBe("ex");
    expect(next.sort).toBe("market_asc");
    expect(next.minPrice).toBe("5");
    expect(next.maxPrice).toBe("50");
    expect(next.hasPrice).toBe("true");
    expect(next.graded).toBe("ungraded");
    expect(next.language).toBe("en");
    // per-game attributes dropped
    expect(next.set).toBeUndefined();
    expect(next.rarity).toBeUndefined();
  });

  it("builds a URL that carries the universal filters but not set/rarity after a switch", () => {
    const url = buildSearchUrl(
      gameSwitchFilters({ game: "pokemon", set: "Base", rarity: "Rare", minPrice: "5" }, "onepiece")
    );
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("game")).toBe("onepiece");
    expect(params.get("minPrice")).toBe("5");
    expect(params.has("set")).toBe(false);
    expect(params.has("rarity")).toBe(false);
  });
});

describe("buildSearchQueryParams", () => {
  it("carries q+game+preserved filters for the multi link, never a sort", () => {
    const qs = buildSearchQueryParams({
      q: "luffy",
      game: "onepiece",
      set: "OP01",
      rarity: "SR",
      graded: "graded",
      minPrice: "1",
      maxPrice: "9",
      hasPrice: "true",
      language: "en",
      sort: "market_desc",
    });
    const params = new URLSearchParams(qs);
    expect(qs.startsWith("/search")).toBe(false);
    expect(params.get("q")).toBe("luffy");
    expect(params.get("game")).toBe("onepiece");
    expect(params.get("set")).toBe("OP01");
    expect(params.get("rarity")).toBe("SR");
    expect(params.get("graded")).toBe("graded");
    expect(params.get("minPrice")).toBe("1");
    expect(params.get("maxPrice")).toBe("9");
    expect(params.get("hasPrice")).toBe("true");
    expect(params.get("language")).toBe("en");
    // multi does not take a sort
    expect(params.has("sort")).toBe(false);
  });
});
