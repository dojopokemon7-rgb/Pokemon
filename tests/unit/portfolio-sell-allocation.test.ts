import { describe, it, expect } from "vitest";
import { allocateSell, type SellRow } from "@/lib/utils/portfolio-sell-allocation";

/**
 * BUG 3 (audit 13 F-02) — oldest-first allocation across a consolidated tile's
 * merged rows (RULE 9). Over-allocation is rejected; a single row passes through.
 */
describe("allocateSell", () => {
  const rowA: SellRow = { id: "a", quantity: 1, addedAt: "2026-01-01T00:00:00.000Z" }; // oldest
  const rowB: SellRow = { id: "b", quantity: 2, addedAt: "2026-02-01T00:00:00.000Z" };

  it("drains the OLDEST row first across rows (regardless of input order)", () => {
    // Pass newest-first (as the consolidation builds allRows in addedAt-desc).
    expect(allocateSell([rowB, rowA], 2)).toEqual([
      { id: "a", quantity: 1 },
      { id: "b", quantity: 1 },
    ]);
  });

  it("exact-fills across all rows", () => {
    expect(allocateSell([rowA, rowB], 3)).toEqual([
      { id: "a", quantity: 1 },
      { id: "b", quantity: 2 },
    ]);
  });

  it("single-row passthrough", () => {
    expect(allocateSell([rowB], 1)).toEqual([{ id: "b", quantity: 1 }]);
  });

  it("rejects selling more than the summed available", () => {
    expect(() => allocateSell([rowA, rowB], 4)).toThrow(/only 3 owned/);
  });

  it("rejects a non-positive / non-integer qty", () => {
    expect(() => allocateSell([rowA], 0)).toThrow();
    expect(() => allocateSell([rowA], 1.5)).toThrow();
  });
});
