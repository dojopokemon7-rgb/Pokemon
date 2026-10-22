import { describe, it, expect } from "vitest";
import { formatCurrency, formatCurrencyCompact } from "@/lib/utils/format";
import { valueAtFraction } from "@/components/AreaChart";

/**
 * Chart Y-axis building blocks. Two pure pieces back the gridline value
 * labels: the compact-USD formatter (shared lift of the card-detail page's
 * old fmtUSDCompact — output MUST be unchanged) and valueAtFraction, which
 * maps a gridline fraction-from-top to its real value given max/min.
 */
describe("formatCurrencyCompact", () => {
  it("matches the former fmtUSDCompact output exactly", () => {
    expect(formatCurrencyCompact(650)).toBe("$650.00");
    expect(formatCurrencyCompact(1000)).toBe("$1K");
    expect(formatCurrencyCompact(7930)).toBe("$7.93K");
    expect(formatCurrencyCompact(61580)).toBe("$61.58K");
  });

  it("keeps sub-$1000 values full (not compacted)", () => {
    expect(formatCurrencyCompact(0)).toBe("$0.00");
    expect(formatCurrencyCompact(999)).toBe("$999.00");
  });

  // audit 04 F-02 (RULE 2 — don't mislabel): stored prices are source-native and
  // may be non-USD (One Piece / Cardmarket EUR). A caller that knows the row's
  // currency must get an HONEST symbol, not a hard-coded "$". These FAIL if "$"
  // is ever re-hard-coded for a non-USD currency.
  it("labels a known non-USD currency honestly (no hard-coded $)", () => {
    expect(formatCurrencyCompact(650, "EUR")).not.toContain("$");
    expect(formatCurrencyCompact(650, "EUR")).toContain("€");
    // compact path too
    expect(formatCurrencyCompact(61580, "EUR")).not.toContain("$");
  });

  it("defaults to USD when no currency is given (byte-for-byte unchanged)", () => {
    expect(formatCurrencyCompact(650)).toBe("$650.00");
    expect(formatCurrencyCompact(61580)).toBe("$61.58K");
  });
});

describe("formatCurrency (audit 04 F-02 — honest currency label)", () => {
  it("defaults to USD and returns — for null/NaN (unchanged)", () => {
    expect(formatCurrency(12.5)).toBe("$12.50");
    expect(formatCurrency(null)).toBe("—");
    expect(formatCurrency(Number.NaN)).toBe("—");
  });

  it("labels a known non-USD currency honestly, never '$'", () => {
    expect(formatCurrency(12.5, "EUR")).toContain("€");
    expect(formatCurrency(12.5, "EUR")).not.toContain("$");
  });

  it("falls back to USD on an invalid currency code (never throws)", () => {
    expect(() => formatCurrency(10, "NOTREAL")).not.toThrow();
    expect(formatCurrency(10, "NOTREAL")).toBe("$10.00");
  });
});

describe("valueAtFraction", () => {
  it("maps the gridline ladder for max=1000, min=0", () => {
    expect(valueAtFraction(0, 1000, 0)).toBe(1000); // top = max
    expect(valueAtFraction(0.25, 1000, 0)).toBe(750);
    expect(valueAtFraction(0.5, 1000, 0)).toBe(500);
    expect(valueAtFraction(0.75, 1000, 0)).toBe(250);
    expect(valueAtFraction(1, 1000, 0)).toBe(0); // bottom = min
  });

  it("handles a nonzero min", () => {
    expect(valueAtFraction(0, 300, 100)).toBe(300);
    expect(valueAtFraction(0.5, 300, 100)).toBe(200);
    expect(valueAtFraction(1, 300, 100)).toBe(100);
  });
});
