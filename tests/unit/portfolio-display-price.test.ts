import { it, expect } from "vitest";
import { displayPrice, gradedPrice, type DisplayPriceItem } from "@/lib/utils/graded-price";

/**
 * QA Desktop D7 — the DISPLAYED headline price of an owned row must apply the
 * graded multiplier, exactly as the gain tag + summary do. A PSA 10 lot and a
 * Raw lot with the SAME raw card.marketPrice must therefore show DIFFERENT
 * prices (the D7 bug was both showing the raw value).
 */
const RAW = 120; // curated (120|10) → 1500, so graded is clearly distinct from raw

function lot(overrides: Partial<DisplayPriceItem>): DisplayPriceItem {
  return {
    condition: null,
    isSold: false,
    soldPrice: null,
    card: { marketPrice: RAW },
    ...overrides,
  };
}

it("graded and raw lots with the same raw marketPrice display DIFFERENT prices", () => {
  const graded = displayPrice(lot({ condition: "PSA 10" }));
  const raw = displayPrice(lot({ condition: null }));

  expect(raw).toBe(RAW);
  expect(graded).toBe(gradedPrice(RAW, 10));
  expect(graded).not.toBe(raw);
});

it("a sold lot displays its recorded soldPrice (unchanged)", () => {
  expect(displayPrice(lot({ isSold: true, soldPrice: 99.5, condition: "PSA 10" }))).toBe(99.5);
});

it("null marketPrice yields null (renders '—', never a fabricated 0)", () => {
  expect(displayPrice(lot({ card: { ...lot({}).card, marketPrice: null } }))).toBeNull();
});
