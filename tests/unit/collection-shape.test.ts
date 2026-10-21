import { describe, it, expect } from "vitest";
/**
 * G1 — the SHARED collection-payload shaping used by BOTH GET
 * /api/users/me/collection and the dashboard SSR page, so `initialItems` carry
 * `card.gradedPrices` (priced current rows + the history-fallback entry) and a
 * graded lot resolves to its real per-grade price on first paint instead of the
 * coarse multiplier. These pin the helper's contract directly.
 */
import {
  COLLECTION_CARD_PRICE_SELECT,
  collectFallbackNeeds,
  indexFallbackRows,
  shapeGradedPrices,
  currentHasGrade,
  type CurrentPriceRow,
} from "@/lib/utils/collection-shape";

type Item = {
  cardId: string;
  condition?: string | null;
  card: { currentPrices?: CurrentPriceRow[] | null };
};

describe("COLLECTION_CARD_PRICE_SELECT", () => {
  it("selects the priced current rows with the fields the graded selector needs", () => {
    expect(COLLECTION_CARD_PRICE_SELECT.where).toEqual({ priceMarket: { not: null } });
    expect(COLLECTION_CARD_PRICE_SELECT.select).toEqual({
      type: true,
      company: true,
      grade: true,
      variant: true,
      condition: true,
      priceMarket: true,
    });
  });
});

describe("currentHasGrade", () => {
  it("matches a graded current row by company+grade (case-insensitive company)", () => {
    const rows: CurrentPriceRow[] = [
      { type: "graded", company: "psa", grade: "9", priceMarket: 6163.18 },
    ];
    expect(currentHasGrade(rows, "PSA", "9")).toBe(true);
    expect(currentHasGrade(rows, "PSA", "10")).toBe(false);
  });

  it("treats a legacy row with no type as graded only via the display-path rule", () => {
    const rows: CurrentPriceRow[] = [{ company: "PSA", grade: "9", priceMarket: 100 }];
    expect(currentHasGrade(rows, "PSA", "9")).toBe(true);
  });

  it("ignores a row with null priceMarket", () => {
    const rows: CurrentPriceRow[] = [
      { type: "graded", company: "PSA", grade: "9", priceMarket: null },
    ];
    expect(currentHasGrade(rows, "PSA", "9")).toBe(false);
  });
});

describe("shapeGradedPrices — current graded row present", () => {
  it("exposes the priced current rows under card.gradedPrices", () => {
    const items: Item[] = [
      {
        cardId: "c1",
        condition: "PSA 9",
        card: {
          currentPrices: [
            { type: "graded", company: "PSA", grade: "9", variant: "normal", priceMarket: 6163.18 },
          ],
        },
      },
    ];
    // No fallback needed when the current snapshot has the grade.
    expect(collectFallbackNeeds(items)).toEqual([]);
    const shaped = shapeGradedPrices(items, new Map());
    expect(shaped[0].card.gradedPrices).toEqual([
      { type: "graded", company: "PSA", grade: "9", variant: "normal", priceMarket: 6163.18 },
    ]);
    // The Prisma relation name must not leak.
    expect("currentPrices" in shaped[0].card).toBe(false);
  });
});

describe("shapeGradedPrices — history fallback (full parity)", () => {
  it("appends a history-fallback entry for a graded lot with no current row", () => {
    const items: Item[] = [
      { cardId: "c1", condition: "PSA 9", card: { currentPrices: [] } },
    ];
    // The lot needs a fallback.
    expect(collectFallbackNeeds(items)).toEqual([{ cardId: "c1", company: "PSA", grade: "9" }]);

    const fallbackByCard = indexFallbackRows([
      {
        cardId: "c1",
        type: "graded",
        company: "psa", // lower-case → normalized on index
        grade: "9",
        variant: "holofoil",
        condition: "PSA 9",
        priceMarket: 5000,
      },
    ]);

    const shaped = shapeGradedPrices(items, fallbackByCard);
    expect(shaped[0].card.gradedPrices).toEqual([
      {
        type: "graded",
        company: "PSA",
        grade: "9",
        variant: "holofoil", // the REAL historical row's variant, preserved
        condition: "PSA 9",
        priceMarket: 5000,
        source: "history",
      },
    ]);
  });

  it("leaves gradedPrices unchanged (no fabricated entry) when no history matches", () => {
    const items: Item[] = [
      { cardId: "c1", condition: "PSA 9", card: { currentPrices: [] } },
    ];
    const shaped = shapeGradedPrices(items, new Map());
    // Empty current + no fallback → gradedPrices stays the empty current array
    // (RULE 2: no invented graded number).
    expect(shaped[0].card.gradedPrices).toEqual([]);
  });

  it("does not touch a raw/ungraded lot", () => {
    const items: Item[] = [
      { cardId: "c1", condition: null, card: { currentPrices: [] } },
    ];
    expect(collectFallbackNeeds(items)).toEqual([]);
    const shaped = shapeGradedPrices(items, new Map());
    expect(shaped[0].card.gradedPrices).toEqual([]);
  });
});
