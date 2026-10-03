import { describe, it, expect } from "vitest";
import { applyRate, convertWithRates } from "@/lib/utils/fx";

/**
 * FX helper (current-price display only). The service layer owns the network;
 * these pin the pure math + the HONEST failure behaviour: an underivable rate
 * must return the SOURCE-NATIVE amount flagged converted:false, never a
 * fabricated number (plan §2).
 */
describe("applyRate", () => {
  it("multiplies amount by rate", () => {
    expect(applyRate(100, 0.9)).toBeCloseTo(90);
  });
});

describe("convertWithRates", () => {
  const base = "USD";
  const rates = { EUR: 0.9, JPY: 150 }; // units per 1 USD

  it("identity when from===to (converted:true, no rate needed)", () => {
    expect(convertWithRates(10, "USD", "USD", base, null)).toEqual({
      amount: 10,
      currency: "USD",
      converted: true,
    });
  });

  it("converts base→target (USD→EUR)", () => {
    const r = convertWithRates(100, "USD", "EUR", base, rates);
    expect(r.converted).toBe(true);
    expect(r.currency).toBe("EUR");
    expect(r.amount).toBeCloseTo(90);
  });

  it("converts non-base source via the base table (JPY→EUR)", () => {
    // 1500 JPY = 10 USD = 9 EUR
    const r = convertWithRates(1500, "JPY", "EUR", base, rates);
    expect(r.converted).toBe(true);
    expect(r.amount).toBeCloseTo(9);
  });

  it("target===base path (JPY→USD)", () => {
    const r = convertWithRates(300, "JPY", "USD", base, rates);
    expect(r.converted).toBe(true);
    expect(r.amount).toBeCloseTo(2); // 300/150
  });

  it("UNAVAILABLE → source-native, converted:false (no rates)", () => {
    expect(convertWithRates(100, "USD", "EUR", base, null)).toEqual({
      amount: 100,
      currency: "USD",
      converted: false,
    });
  });

  it("UNAVAILABLE → source-native when source currency missing from table", () => {
    const r = convertWithRates(100, "GBP", "EUR", base, rates);
    expect(r.converted).toBe(false);
    expect(r.currency).toBe("GBP");
    expect(r.amount).toBe(100); // never fabricated
  });
});
