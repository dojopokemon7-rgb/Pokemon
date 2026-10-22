import { describe, it, expect } from "vitest";
import { isNonEmptyPricesPayload } from "@/lib/utils/prices-payload";

/**
 * Guard used by the search-grid prefetch to avoid pinning a transient-empty
 * `/prices` payload into the ["card-prices", id] cache (the confirmed
 * card-detail root cause). True ONLY for an object whose `prices` is a
 * non-empty array; everything else (empty array, missing key, null, non-object)
 * is false so the prefetch throws and writes no cache entry.
 */
describe("isNonEmptyPricesPayload", () => {
  it("returns true for a non-empty prices array", () => {
    expect(isNonEmptyPricesPayload({ prices: [{ type: "raw", price: 494.19 }] })).toBe(true);
  });

  it("returns false for an empty prices array", () => {
    expect(isNonEmptyPricesPayload({ prices: [], weeklyChangePct: null })).toBe(false);
  });

  it("returns false when the prices key is missing", () => {
    expect(isNonEmptyPricesPayload({ weeklyChangePct: null })).toBe(false);
  });

  it("returns false when prices is not an array", () => {
    expect(isNonEmptyPricesPayload({ prices: "nope" })).toBe(false);
  });

  it("returns false for null and non-object inputs", () => {
    expect(isNonEmptyPricesPayload(null)).toBe(false);
    expect(isNonEmptyPricesPayload(undefined)).toBe(false);
    expect(isNonEmptyPricesPayload("prices")).toBe(false);
    expect(isNonEmptyPricesPayload(42)).toBe(false);
  });
});
