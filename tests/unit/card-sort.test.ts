import { describe, it, expect } from "vitest";
import { orderByForCardSort, CARD_SORT_LABELS } from "@/lib/utils/card-sort";

/**
 * Unit test for the shared card sort mapping. Trivial-but-real: if the
 * orderBy shape for a sort key ever changes, this fails — the smallest
 * check that proves the unit runner + path aliases work.
 */
describe("orderByForCardSort", () => {
  it("maps name_asc to a single name-ascending clause", () => {
    expect(orderByForCardSort("name_asc")).toEqual([{ name: "asc" }]);
  });

  it("defaults market_desc to price-desc then name", () => {
    expect(orderByForCardSort("market_desc")).toEqual([
      { marketPrice: { sort: "desc", nulls: "last" } },
      { name: "asc" },
    ]);
  });

  it("has a label for every sort key", () => {
    for (const key of ["trending", "market_desc", "market_asc", "name_asc", "recent"] as const) {
      expect(CARD_SORT_LABELS[key]).toBeTruthy();
    }
  });
});
