import { describe, it, expect } from "vitest";
import { formatCurrencyCompact } from "@/lib/utils/format";
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
