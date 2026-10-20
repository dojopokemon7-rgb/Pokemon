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

it("a graded lot with a MATCHING real graded price displays THAT price (not the multiplier, not raw)", () => {
  // The REAL stored PSA 10 price for this card is $777 — distinct from both the
  // raw $120 and the coarse-multiplier fallback gradedPrice(120, 10)=1500.
  const real = displayPrice(
    lot({
      condition: "PSA 10",
      card: {
        ...lot({}).card,
        gradedPrices: [{ company: "PSA", grade: "10", priceMarket: 777 }],
      },
    })
  );
  expect(real).toBe(777);
  expect(real).not.toBe(RAW);
  expect(real).not.toBe(gradedPrice(RAW, 10));
});

it("a graded lot with NO matching real row falls back to the multiplier", () => {
  // Stored row is PSA 9, but the lot is PSA 10 → no match → multiplier fallback.
  const fallback = displayPrice(
    lot({
      condition: "PSA 10",
      card: {
        ...lot({}).card,
        gradedPrices: [{ company: "PSA", grade: "9", priceMarket: 300 }],
      },
    })
  );
  expect(fallback).toBe(gradedPrice(RAW, 10));
});

it("a matching row with a null priceMarket is not used (falls back, never a fabricated number)", () => {
  const fallback = displayPrice(
    lot({
      condition: "PSA 10",
      card: {
        ...lot({}).card,
        gradedPrices: [{ company: "PSA", grade: "10", priceMarket: null }],
      },
    })
  );
  expect(fallback).toBe(gradedPrice(RAW, 10));
});

it("a graded lot with NO real price AND a null raw marketPrice yields null", () => {
  expect(
    displayPrice(
      lot({ condition: "PSA 10", card: { ...lot({}).card, marketPrice: null } })
    )
  ).toBeNull();
});

it("a sold lot displays its recorded soldPrice (unchanged)", () => {
  expect(displayPrice(lot({ isSold: true, soldPrice: 99.5, condition: "PSA 10" }))).toBe(99.5);
});

it("null marketPrice yields null (renders '—', never a fabricated 0)", () => {
  expect(displayPrice(lot({ card: { ...lot({}).card, marketPrice: null } }))).toBeNull();
});
