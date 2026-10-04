import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * FEAT-001 — PSA Population pipeline (Part 1). Integration contract pinned
 * against a MOCKED Prisma client + MOCKED Scrydex client + MOCKED credit gate.
 * ZERO external calls, ZERO credits, no live DB.
 *
 * Pins:
 *   1. getStoredPopulationReport store->read round-trip: returns the mapped
 *      { source, companies:[PSA...], refreshedAt } when a row exists, null when
 *      none; zero external calls; BGS never present.
 *   2. pullAndStorePopulation credit gate: throws ScrydexCreditsNotApproved +
 *      makes NO fetch when the gate is unapproved.
 *   3. pullAndStorePopulation (gate approved): a non-null fetch upserts + writes
 *      an `ok` scrydex_population SyncLog; a null fetch writes `failed` and does
 *      NOT upsert (no-clobber).
 */

const prismaMock = vi.hoisted(() => ({
  card: { findFirst: vi.fn(), update: vi.fn() },
  populationReport: { findUnique: vi.fn(), upsert: vi.fn() },
  syncLog: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

// Scrydex thin client — mocked so NO real network/credits happen.
const scrydexMock = vi.hoisted(() => ({
  fetchScrydexPopulation: vi.fn(),
  resolveScrydexCard: vi.fn(),
  // referenced by scrydex-pricing.service imports (unused here)
  fetchScrydexCardById: vi.fn(),
  fetchScrydexPriceHistory: vi.fn(),
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

import { Game } from "@prisma/client";
import { getStoredPopulationReport } from "@/lib/services/population.service";
import { pullAndStorePopulation } from "@/lib/services/scrydex-pricing.service";
import { ScrydexCreditsNotApproved, type ScrydexOp } from "@/lib/services/scrydex-credit-gate";

beforeEach(() => {
  vi.clearAllMocks();
  gateMock.approved = false;
});

describe("getStoredPopulationReport (pure read, zero credits)", () => {
  it("maps a stored row to the PSA-only report shape", async () => {
    prismaMock.card.findFirst.mockResolvedValue({ id: "card_1" });
    const refreshedAt = new Date("2026-01-02T00:00:00.000Z");
    prismaMock.populationReport.findUnique.mockResolvedValue({
      cardId: "card_1",
      source: "scrydex",
      company: "PSA",
      language: "English",
      grades: [
        { grade: "10", count: 1200 },
        { grade: "9", count: 800 },
      ],
      total: 2000,
      refreshedAt,
    });

    const result = await getStoredPopulationReport("base1-4");

    expect(result).toEqual({
      source: "scrydex",
      companies: [
        {
          company: "PSA",
          language: "English",
          total: 2000,
          grades: [
            { grade: "10", count: 1200 },
            { grade: "9", count: 800 },
          ],
        },
      ],
      refreshedAt: refreshedAt.toISOString(),
    });
    // BGS is never present.
    expect(result?.companies.some((c) => (c.company as string) === "BGS")).toBe(false);
    // Zero external calls.
    expect(scrydexMock.fetchScrydexPopulation).not.toHaveBeenCalled();
  });

  it("returns null when the card has no stored report", async () => {
    prismaMock.card.findFirst.mockResolvedValue({ id: "card_1" });
    prismaMock.populationReport.findUnique.mockResolvedValue(null);

    const result = await getStoredPopulationReport("base1-4");

    expect(result).toBeNull();
    expect(scrydexMock.fetchScrydexPopulation).not.toHaveBeenCalled();
  });

  it("returns null when the card does not exist", async () => {
    prismaMock.card.findFirst.mockResolvedValue(null);

    const result = await getStoredPopulationReport("missing");

    expect(result).toBeNull();
    expect(prismaMock.populationReport.findUnique).not.toHaveBeenCalled();
  });

  it("returns null when the stored blob is malformed (Zod re-parse fails)", async () => {
    prismaMock.card.findFirst.mockResolvedValue({ id: "card_1" });
    prismaMock.populationReport.findUnique.mockResolvedValue({
      total: 10,
      grades: [{ grade: "10" }], // missing count → malformed
      refreshedAt: new Date(),
    });

    const result = await getStoredPopulationReport("base1-4");
    expect(result).toBeNull();
  });
});

describe("pullAndStorePopulation (credit-gated writer)", () => {
  const card = {
    id: "card_1",
    game: Game.POKEMON,
    scrydexId: "me55c-4",
    name: "Charizard",
    number: "4",
  };

  it("throws ScrydexCreditsNotApproved and makes NO fetch when the gate is denied", async () => {
    gateMock.approved = false;

    await expect(pullAndStorePopulation(card)).rejects.toBeInstanceOf(ScrydexCreditsNotApproved);

    expect(scrydexMock.fetchScrydexPopulation).not.toHaveBeenCalled();
    expect(prismaMock.populationReport.upsert).not.toHaveBeenCalled();
    expect(prismaMock.syncLog.create).not.toHaveBeenCalled();
  });

  it("upserts and writes an ok scrydex_population SyncLog on a non-null fetch", async () => {
    gateMock.approved = true;
    scrydexMock.fetchScrydexPopulation.mockResolvedValue({
      company: "PSA",
      language: "English",
      total: 2000,
      grades: [{ grade: "10", count: 1200 }],
    });

    const result = await pullAndStorePopulation(card);

    expect(result).toEqual({ stored: true, credits: 1 });
    expect(scrydexMock.fetchScrydexPopulation).toHaveBeenCalledWith("me55c-4", Game.POKEMON);
    expect(prismaMock.populationReport.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          cardId_source_company_language: {
            cardId: "card_1",
            source: "scrydex",
            company: "PSA",
            language: "English",
          },
        },
      })
    );
    expect(prismaMock.syncLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          job: "scrydex_population",
          cardId: "card_1",
          status: "ok",
          credits: 1,
        }),
      })
    );
  });

  it("writes failed and does NOT upsert (no-clobber) on a null fetch", async () => {
    gateMock.approved = true;
    scrydexMock.fetchScrydexPopulation.mockResolvedValue(null);

    const result = await pullAndStorePopulation(card);

    expect(result).toEqual({ stored: false, credits: 1 });
    expect(prismaMock.populationReport.upsert).not.toHaveBeenCalled();
    expect(prismaMock.syncLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ job: "scrydex_population", status: "failed", credits: 1 }),
      })
    );
  });

  it("resolves scrydexId when absent, caches it, then fetches", async () => {
    gateMock.approved = true;
    scrydexMock.resolveScrydexCard.mockResolvedValue({ scrydexId: "resolved-9", card: {} });
    scrydexMock.fetchScrydexPopulation.mockResolvedValue({
      company: "PSA",
      language: "English",
      total: 5,
      grades: [{ grade: "10", count: 5 }],
    });

    const result = await pullAndStorePopulation({
      id: "card_2",
      game: Game.POKEMON,
      name: "Blastoise",
      number: "2",
    });

    expect(result.stored).toBe(true);
    expect(scrydexMock.resolveScrydexCard).toHaveBeenCalled();
    expect(prismaMock.card.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { scrydexId: "resolved-9" } })
    );
    expect(scrydexMock.fetchScrydexPopulation).toHaveBeenCalledWith("resolved-9", Game.POKEMON);
  });

  it("writes failed without fetching when no scrydexId can be resolved", async () => {
    gateMock.approved = true;
    scrydexMock.resolveScrydexCard.mockResolvedValue(null);

    const result = await pullAndStorePopulation({
      id: "card_3",
      game: Game.POKEMON,
      name: "Unknown",
      number: "999",
    });

    expect(result).toEqual({ stored: false, credits: 1 });
    expect(scrydexMock.fetchScrydexPopulation).not.toHaveBeenCalled();
    expect(prismaMock.syncLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ job: "scrydex_population", status: "failed" }),
      })
    );
  });
});
