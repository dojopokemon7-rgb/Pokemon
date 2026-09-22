import { describe, it, expect } from "vitest";
import {
  getGradedPrice,
  resolveGradedPrice,
  STALE_AFTER_MS,
} from "@/lib/utils/graded-price";

/**
 * F-17 Step 9 — regression guards for graded pricing.
 *
 * These cover behaviors the plain lookup doesn't: grade ordering,
 * staleness flagging, and resilience when the price source fails. They
 * exercise `resolveGradedPrice`, which returns a structured result
 * `{ price, isStale, isFallback }` (the plain number-returning
 * getGradedPrice/gradedPrice keep serving the golden fast path).
 */

describe("grade hierarchy enforcement", () => {
  it("PSA 10 > PSA 9 > PSA 8 for the same card (curated)", () => {
    const p10 = getGradedPrice("Charizard", "Base Set", 10, 3500);
    const p9 = getGradedPrice("Charizard", "Base Set", 9, 3500);
    const p8 = getGradedPrice("Charizard", "Base Set", 8, 3500);
    expect(p10).toBeGreaterThan(p9);
    expect(p9).toBeGreaterThan(p8);
  });

  it("never returns a lower price for a higher grade, even on the fallback path", () => {
    // An unlisted card exercises the coarse multiplier fallback.
    const raw = 100;
    const p8 = getGradedPrice("Unlisted Mon", "Nowhere Set", 8, raw);
    const p9 = getGradedPrice("Unlisted Mon", "Nowhere Set", 9, raw);
    const p10 = getGradedPrice("Unlisted Mon", "Nowhere Set", 10, raw);
    expect(p10).toBeGreaterThan(p9);
    expect(p9).toBeGreaterThan(p8);
  });
});

describe("stale cache handling", () => {
  it("flags a price older than the staleness threshold as stale", () => {
    const old = new Date(Date.now() - (STALE_AFTER_MS + 60_000));
    const res = resolveGradedPrice({
      cardName: "Charizard",
      setName: "Base Set",
      grade: 10,
      rawMarketPrice: 3500,
      lastPricedAt: old,
    });
    expect(res.isStale).toBe(true);
    expect(res.price).toBe(35000); // still returns the value, just flagged
  });

  it("does not flag a fresh price as stale", () => {
    const res = resolveGradedPrice({
      cardName: "Charizard",
      setName: "Base Set",
      grade: 10,
      rawMarketPrice: 3500,
      lastPricedAt: new Date(),
    });
    expect(res.isStale).toBe(false);
  });
});

describe("API-down / fallback resilience", () => {
  it("never crashes when the price source throws; flags the result", () => {
    const res = resolveGradedPrice({
      cardName: "Charizard",
      setName: "Base Set",
      grade: 10,
      rawMarketPrice: 3500,
      priceSource: () => {
        throw new Error("pricing API down");
      },
    });
    expect(typeof res.price).toBe("number");
    expect(res.price).toBeGreaterThan(0);
    expect(res.isFallback).toBe(true);
  });

  it("uses the source value when it succeeds (not a fallback)", () => {
    const res = resolveGradedPrice({
      cardName: "Charizard",
      setName: "Base Set",
      grade: 10,
      rawMarketPrice: 3500,
      priceSource: () => 40000,
    });
    expect(res.price).toBe(40000);
    expect(res.isFallback).toBe(false);
  });
});
