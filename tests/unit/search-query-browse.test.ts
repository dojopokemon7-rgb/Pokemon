import { describe, it, expect } from "vitest";
import { isValidSearchRequest, hasActiveFilter } from "@/lib/utils/search-query";

describe("browse-mode request rule", () => {
  it("empty query + no filter is invalid", () => {
    expect(isValidSearchRequest({})).toBe(false);
    expect(isValidSearchRequest({ query: "   " })).toBe(false);
    expect(isValidSearchRequest({ query: "", language: "all" })).toBe(false);
  });
  it("empty query + any filter is valid", () => {
    for (const f of [
      { set: "Base" }, { rarity: "Rare" }, { graded: "graded" }, { minPrice: 0 },
      { maxPrice: 5 }, { hasPrice: "true" }, { language: "ja" },
    ]) {
      expect(isValidSearchRequest({ query: "", ...f })).toBe(true);
    }
  });
  it("query alone is valid; empty-string prices are not filters", () => {
    expect(isValidSearchRequest({ query: "char" })).toBe(true);
    expect(hasActiveFilter({ minPrice: "", maxPrice: "" })).toBe(false);
  });
});
