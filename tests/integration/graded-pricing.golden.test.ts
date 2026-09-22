import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// F-17 target contract: a PSA-graded pricing utility that maps a raw
// (ungraded) market price + a PSA grade to the graded market value.
// This module does not exist yet — importing it is the first red.
import { gradedPrice } from "@/lib/utils/graded-price";

interface GoldenCard {
  id: string;
  name: string;
  set: string;
  game: "pokemon" | "onepiece";
  grade: number;
  rawMarketPrice: number;
  gradedMarketValue: number;
}

const golden = JSON.parse(
  readFileSync(join(process.cwd(), "tests", "fixtures", "golden_prices.json"), "utf8")
) as GoldenCard[];

const TOLERANCE = 0.1; // ±10%

describe("PSA graded pricing vs golden oracle", () => {
  it("has exactly 20 golden cards", () => {
    expect(golden).toHaveLength(20);
  });

  for (const card of golden) {
    it(`${card.name} — ${card.set} PSA ${card.grade} within ±10% of $${card.gradedMarketValue}`, () => {
      const predicted = gradedPrice(card.rawMarketPrice, card.grade);
      const lower = card.gradedMarketValue * (1 - TOLERANCE);
      const upper = card.gradedMarketValue * (1 + TOLERANCE);
      expect(
        predicted,
        `predicted $${predicted} for ${card.id}, golden $${card.gradedMarketValue} (allowed $${lower.toFixed(2)}–$${upper.toFixed(2)})`
      ).toBeGreaterThanOrEqual(lower);
      expect(predicted).toBeLessThanOrEqual(upper);
    });
  }
});
