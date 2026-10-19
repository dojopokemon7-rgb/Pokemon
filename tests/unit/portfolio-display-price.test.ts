import { it, expect } from "vitest";
import { displayPrice, type CollectionItem } from "@/app/(dashboard)/portfolio/page";
import { gradedPrice } from "@/lib/utils/graded-price";

/**
 * QA Desktop D7 — the DISPLAYED headline price of an owned row must apply the
 * graded multiplier, exactly as the gain tag + summary do. A PSA 10 lot and a
 * Raw lot with the SAME raw card.marketPrice must therefore show DIFFERENT
 * prices (the D7 bug was both showing the raw value).
 */
const RAW = 120; // curated (120|10) → 1500, so graded is clearly distinct from raw

function lot(overrides: Partial<CollectionItem>): CollectionItem {
  return {
    id: "l1",
    cardId: "c1",
    quantity: 1,
    isFoil: false,
    condition: null,
    purchasePrice: null,
    isSold: false,
    soldPrice: null,
    addedAt: "2024-01-01T00:00:00.000Z",
    card: {
      id: "c1",
      name: "Pikachu",
      number: "58",
      rarity: null,
      imageUrl: null,
      marketPrice: RAW,
      set: { name: "Base Set" },
    },
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
