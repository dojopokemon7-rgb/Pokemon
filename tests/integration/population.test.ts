import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
          // C3: a legacy bare-array blob reads back with null ladder totals.
          gradeTotal: null,
          qualifiedGradeTotal: null,
          halfGradeTotal: null,
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

  // C3 — the stored grades blob can be EITHER the legacy bare array OR the new
  // object carrying the ladder totals. Both must read back; a legacy array
  // normalizes to null totals (back-compat, no backfill).
  it("reads the NEW object blob with ladder totals", async () => {
    prismaMock.card.findFirst.mockResolvedValue({ id: "card_1" });
    const refreshedAt = new Date("2026-01-03T00:00:00.000Z");
    prismaMock.populationReport.findUnique.mockResolvedValue({
      total: 2650,
      grades: {
        grades: [
          { grade: "10", count: 1200 },
          { grade: "9.5", count: 300 },
          { grade: "9", count: 800 },
          { grade: "8.5", count: 150 },
          { grade: "9Q", count: 200 },
        ],
        gradeTotal: 2000,
        qualifiedGradeTotal: 200,
        halfGradeTotal: 450,
      },
      refreshedAt,
    });

    const result = await getStoredPopulationReport("base1-4");
    expect(result?.companies[0]).toMatchObject({
      company: "PSA",
      language: "English",
      total: 2650,
      gradeTotal: 2000,
      qualifiedGradeTotal: 200,
      halfGradeTotal: 450,
    });
    expect(result?.companies[0].grades).toHaveLength(5);
  });

  it("reads a LEGACY bare {grade,count}[] blob with null ladder totals (back-compat)", async () => {
    prismaMock.card.findFirst.mockResolvedValue({ id: "card_1" });
    prismaMock.populationReport.findUnique.mockResolvedValue({
      total: 2000,
      grades: [
        { grade: "10", count: 1200 },
        { grade: "9", count: 800 },
      ],
      refreshedAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    const result = await getStoredPopulationReport("base1-4");
    expect(result?.companies[0]).toMatchObject({
      total: 2000,
      gradeTotal: null,
      qualifiedGradeTotal: null,
      halfGradeTotal: null,
    });
    expect(result?.companies[0].grades).toHaveLength(2);
  });
});

// C3 — the REAL thin-client aggregation (fetchScrydexPopulation). The rest of
// this file mocks @/lib/services/scrydex.service; here we pull the ACTUAL
// implementation via importActual and stub global.fetch so no live call /
// credit happens. Pins the full ladder end to end across BOTH payload shapes:
// one entry mixing half ("8.5") / qualified ("9Q") into grades[], and one
// nesting them under half_grades / qualified_grades.
describe("fetchScrydexPopulation — full ladder (real aggregation, mocked fetch)", () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    process.env.SCRYDEX_API_KEY = "test-key";
    process.env.SCRYDEX_TEAM_ID = "test-team";
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  async function runFetch(variants: unknown[]) {
    const actual = await vi.importActual<typeof import("@/lib/services/scrydex.service")>(
      "@/lib/services/scrydex.service"
    );
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { variants } }),
    })) as unknown as typeof fetch;
    return actual.fetchScrydexPopulation("me55c-4", Game.POKEMON);
  }

  it("surfaces ladder totals + all grades when half/qualified are MIXED into grades[]", async () => {
    const result = await runFetch([
      {
        name: "holofoil",
        pop_reports: [
          {
            company: "PSA",
            language: "English",
            total: 2650,
            grade_total: 2000,
            qualified_grade_total: 200,
            half_grade_total: 450,
            grades: [
              { grade: "10", count: 1200 },
              { grade: "9.5", count: 300 },
              { grade: "9", count: 800 },
              { grade: "8.5", count: 150 },
              { grade: "9Q", count: 200 },
            ],
          },
        ],
      },
    ]);

    expect(result).toMatchObject({
      company: "PSA",
      language: "English",
      total: 2650,
      gradeTotal: 2000,
      qualifiedGradeTotal: 200,
      halfGradeTotal: 450,
    });
    const byGrade = Object.fromEntries(result!.grades.map((g) => [g.grade, g.count]));
    expect(byGrade["10"]).toBe(1200);
    expect(byGrade["8.5"]).toBe(150); // half-grade retained verbatim
    expect(byGrade["9Q"]).toBe(200); // qualified retained verbatim
  });

  it("flattens half_grades / qualified_grades when they ship under SEPARATE keys", async () => {
    const result = await runFetch([
      {
        name: "holofoil",
        pop_reports: [
          {
            company: "PSA",
            language: "English",
            total: 1850,
            grade_total: 1600,
            qualified_grade_total: 100,
            half_grade_total: 150,
            grades: [
              { grade: "10", count: 1000 },
              { grade: "9", count: 600 },
            ],
            half_grades: [{ grade: "8.5", count: 150 }],
            qualified_grades: [{ grade: "9Q", count: 100 }],
          },
        ],
      },
    ]);

    expect(result).toMatchObject({
      gradeTotal: 1600,
      qualifiedGradeTotal: 100,
      halfGradeTotal: 150,
    });
    const byGrade = Object.fromEntries(result!.grades.map((g) => [g.grade, g.count]));
    // Nested-key half/qualified grades flattened into the one grades[] map.
    expect(byGrade["8.5"]).toBe(150);
    expect(byGrade["9Q"]).toBe(100);
    expect(byGrade["10"]).toBe(1000);
  });

  it("surfaces null ladder totals when the payload omits them (honest, not fabricated)", async () => {
    const result = await runFetch([
      {
        name: "holofoil",
        pop_reports: [
          { company: "PSA", language: "English", total: 50, grades: [{ grade: "10", count: 50 }] },
        ],
      },
    ]);
    expect(result).toMatchObject({
      total: 50,
      gradeTotal: null,
      qualifiedGradeTotal: null,
      halfGradeTotal: null,
    });
  });
});

describe("pullAndStorePopulation — C3 writes the widened grades JSON object", () => {
  const card = {
    id: "card_1",
    game: Game.POKEMON,
    scrydexId: "me55c-4",
    name: "Charizard",
    number: "4",
  };

  it("persists { grades, gradeTotal, qualifiedGradeTotal, halfGradeTotal } (object, not bare array)", async () => {
    gateMock.approved = true;
    scrydexMock.fetchScrydexPopulation.mockResolvedValue({
      company: "PSA",
      language: "English",
      total: 2650,
      gradeTotal: 2000,
      qualifiedGradeTotal: 200,
      halfGradeTotal: 450,
      grades: [
        { grade: "10", count: 1200 },
        { grade: "9Q", count: 200 },
      ],
    });

    await pullAndStorePopulation(card);

    const upsertArg = prismaMock.populationReport.upsert.mock.calls[0][0];
    expect(upsertArg.create.grades).toEqual({
      grades: [
        { grade: "10", count: 1200 },
        { grade: "9Q", count: 200 },
      ],
      gradeTotal: 2000,
      qualifiedGradeTotal: 200,
      halfGradeTotal: 450,
    });
    expect(upsertArg.create.total).toBe(2650); // top-level column unchanged
    expect(upsertArg.update.grades).toMatchObject({ gradeTotal: 2000 });
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
