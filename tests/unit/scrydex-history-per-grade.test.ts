import { describe, it, expect, vi, beforeEach } from "vitest";
import { Game } from "@prisma/client";

/**
 * FEAT-001 — per-grade GRADED price-history capture in
 * pullAndStoreScrydexHistory. Pinned against a MOCKED Prisma client, a MOCKED
 * Scrydex thin client, and a MOCKED credit gate. ZERO external calls, ZERO
 * credits, no live DB.
 *
 * Pins:
 *   AC-15 (gate DENY): with the gate denied, the per-grade capture throws
 *     ScrydexCreditsNotApproved and NEITHER the fetch mock NOR createMany ran.
 *   AC-14 (store per grade): with the gate approved, each requested
 *     (company, grade) stores type="graded" rows with the REQUESTED company
 *     (uppercased) + grade (verbatim) STAMPED on; a null market+low point is
 *     skipped; a no-history (company, grade) stores nothing. The raw NM capture
 *     is unchanged.
 */

// --- Shared mocks -----------------------------------------------------------

const prismaMock = vi.hoisted(() => ({
  pricingHistory: { createMany: vi.fn() },
  syncLog: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

// Scrydex thin client — mocked so NO real network/credits happen.
const scrydexMock = vi.hoisted(() => ({
  fetchScrydexPriceHistory: vi.fn(),
  // referenced by scrydex-pricing.service imports (unused here)
  fetchScrydexCardById: vi.fn(),
  fetchScrydexPopulation: vi.fn(),
  fetchScrydexSoldListings: vi.fn(),
  resolveScrydexCard: vi.fn(),
  pickRawPrice: vi.fn(),
}));
vi.mock("@/lib/services/scrydex.service", () => scrydexMock);

// Credit gate — toggled per test. Real ScrydexCreditsNotApproved is re-exported
// so the thrown instance matches what callers catch.
const gateMock = vi.hoisted(() => ({ approved: false }));
vi.mock("@/lib/services/scrydex-credit-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/scrydex-credit-gate")>();
  return {
    ...actual,
    assertScrydexCreditsApproved: vi.fn(async (op: ScrydexOp, count = 1) => {
      if (gateMock.approved) return;
      throw new actual.ScrydexCreditsNotApproved(op, actual.estimateCredits(op, count));
    }),
    isScrydexLiveApproved: vi.fn(async () => gateMock.approved),
  };
});

// redis singleton — not exercised here but imported transitively.
const redisMock = vi.hoisted(() => ({ del: vi.fn(async () => 1), get: vi.fn(async () => null) }));
vi.mock("@/lib/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/redis")>();
  return { ...actual, redis: redisMock };
});

import { pullAndStoreScrydexHistory } from "@/lib/services/scrydex-pricing.service";
import {
  ScrydexCreditsNotApproved,
  type ScrydexOp,
} from "@/lib/services/scrydex-credit-gate";

const CARD = { id: "card_1", scrydexId: "me55c-4", game: Game.POKEMON };

beforeEach(() => {
  vi.clearAllMocks();
  gateMock.approved = false;
});

describe("pullAndStoreScrydexHistory — per-grade capture (credit-gated)", () => {
  it("AC-15: gate DENY throws ScrydexCreditsNotApproved and makes NO fetch / NO createMany", async () => {
    gateMock.approved = false;

    await expect(
      pullAndStoreScrydexHistory(CARD, {
        grades: [{ company: "PSA", grade: "10" }],
      })
    ).rejects.toBeInstanceOf(ScrydexCreditsNotApproved);

    expect(scrydexMock.fetchScrydexPriceHistory).not.toHaveBeenCalled();
    expect(prismaMock.pricingHistory.createMany).not.toHaveBeenCalled();
  });

  it("AC-14: stores type=graded rows per requested (company,grade), stamping the REQUESTED labels", async () => {
    gateMock.approved = true;
    // 1st call = raw NM; 2nd call = PSA 10 graded series.
    scrydexMock.fetchScrydexPriceHistory
      .mockResolvedValueOnce([
        { date: "2026-01-01", prices: [{ type: "raw", condition: "NM", market: 100, currency: "USD" }] },
      ])
      .mockResolvedValueOnce([
        // graded point with a real market
        { date: "2026-01-01", prices: [{ market: 900, currency: "USD" }] },
        // graded point with null market+low → MUST be skipped (honest gap)
        { date: "2026-01-02", prices: [{ market: null, low: null, currency: "USD" }] },
      ]);

    const result = await pullAndStoreScrydexHistory(CARD, {
      grades: [{ company: "psa", grade: "10" }], // lowercase company → stored uppercase
    });

    // raw NM call + 1 graded call = 2 fetches; credits = 3 * (1 + 1) = 6.
    expect(scrydexMock.fetchScrydexPriceHistory).toHaveBeenCalledTimes(2);
    expect(result.credits).toBe(6);

    // Two createMany: one raw batch, one graded batch.
    expect(prismaMock.pricingHistory.createMany).toHaveBeenCalledTimes(2);

    // The graded batch stamps the REQUESTED company (uppercased) + grade,
    // type="graded", and drops the null-priced point.
    const gradedCall = prismaMock.pricingHistory.createMany.mock.calls.find((c) =>
      c[0].data.some((r: { type: string }) => r.type === "graded")
    );
    expect(gradedCall).toBeDefined();
    const gradedRows = gradedCall![0].data as Array<{
      type: string;
      company: string;
      grade: string;
      priceMarket: number | null;
    }>;
    expect(gradedRows).toHaveLength(1); // null point skipped
    expect(gradedRows[0]).toMatchObject({
      type: "graded",
      company: "PSA", // uppercased from "psa"
      grade: "10", // verbatim
      priceMarket: 900,
    });
  });

  it("AC-14: a no-history (company,grade) stores nothing for that grade", async () => {
    gateMock.approved = true;
    scrydexMock.fetchScrydexPriceHistory
      .mockResolvedValueOnce([
        { date: "2026-01-01", prices: [{ type: "raw", condition: "NM", market: 100, currency: "USD" }] },
      ])
      .mockResolvedValueOnce(null); // no history for the requested grade

    const result = await pullAndStoreScrydexHistory(CARD, {
      grades: [{ company: "CGC", grade: "9.5" }],
    });

    // Only the raw batch was written; no graded createMany.
    const gradedCall = prismaMock.pricingHistory.createMany.mock.calls.find((c) =>
      c[0].data.some((r: { type: string }) => r.type === "graded")
    );
    expect(gradedCall).toBeUndefined();
    expect(result.stored).toBe(1); // just the raw point
  });
});
