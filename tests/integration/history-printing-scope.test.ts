import { describe, it, expect, vi, beforeEach } from "vitest";
import { Game } from "@prisma/client";

/**
 * Per-printing scope (AGENTS.md RULE 3) for pullAndStoreScrydexHistory. The
 * /price_history payload carries EVERY sibling printing's variant points
 * (shared scrydexId), so the writer must persist ONLY the row's printing
 * variant — with a never-store-zero fallback to ALL variants + console.warn
 * when the printing is absent from the payload (RULE 2). Mirrors the price
 * writer scoping shipped in 229f16c.
 *
 * Pinned against a MOCKED Prisma client, a MOCKED Scrydex thin client, and a
 * MOCKED credit gate (approved). ZERO external calls, ZERO credits, no live DB.
 */

const prismaMock = vi.hoisted(() => ({
  pricingHistory: { createMany: vi.fn() },
  syncLog: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const scrydexMock = vi.hoisted(() => ({
  fetchScrydexPriceHistory: vi.fn(),
  fetchScrydexCardById: vi.fn(),
  fetchScrydexPopulation: vi.fn(),
  fetchScrydexSoldListings: vi.fn(),
  resolveScrydexCard: vi.fn(),
  pickRawPrice: vi.fn(),
}));
vi.mock("@/lib/services/scrydex.service", () => scrydexMock);

const gateMock = vi.hoisted(() => ({ approved: false }));
vi.mock("@/lib/services/scrydex-credit-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/scrydex-credit-gate")>();
  return {
    ...actual,
    assertScrydexEnrichApproved: vi.fn(async (op: ScrydexOp, count = 1) => {
      if (gateMock.approved) return;
      throw new actual.ScrydexCreditsNotApproved(op, actual.estimateCredits(op, count));
    }),
    isScrydexLiveApproved: vi.fn(async () => gateMock.approved),
  };
});

const redisMock = vi.hoisted(() => ({ del: vi.fn(async () => 1), get: vi.fn(async () => null) }));
vi.mock("@/lib/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/redis")>();
  return { ...actual, redis: redisMock };
});

import { pullAndStoreScrydexHistory } from "@/lib/services/scrydex-pricing.service";
import { type ScrydexOp } from "@/lib/services/scrydex-credit-gate";

const SCRYDEX_ID = "base1-2";

// A raw-NM price_history response carrying THREE sibling variants' points.
function mixedRawDays() {
  return [
    {
      date: "2026-01-01",
      prices: [
        { type: "raw", condition: "NM", variant: "unlimitedHolofoil", market: 300, currency: "USD" },
        { type: "raw", condition: "NM", variant: "unlimitedShadowlessHolofoil", market: 500, currency: "USD" },
        { type: "raw", condition: "NM", variant: "firstEditionShadowlessHolofoil", market: 900, currency: "USD" },
      ],
    },
  ];
}

type RawRow = { variant: string; type?: string };
function allWrittenRows(): RawRow[] {
  return prismaMock.pricingHistory.createMany.mock.calls.flatMap((c) => c[0].data as RawRow[]);
}

beforeEach(() => {
  vi.clearAllMocks();
  gateMock.approved = true;
});

describe("pullAndStoreScrydexHistory — per-printing variant scope", () => {
  it("stores ONLY the row's printing variant points, dropping sibling variants", async () => {
    scrydexMock.fetchScrydexPriceHistory.mockResolvedValueOnce(mixedRawDays());

    const result = await pullAndStoreScrydexHistory({
      id: "card_1",
      game: Game.POKEMON,
      scrydexId: SCRYDEX_ID,
      printing: "unlimitedShadowlessHolofoil",
    });

    const rows = allWrittenRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.variant === "unlimitedShadowlessHolofoil")).toBe(true);
    // No sibling variant leaked through.
    expect(rows.some((r) => r.variant === "unlimitedHolofoil")).toBe(false);
    expect(rows.some((r) => r.variant === "firstEditionShadowlessHolofoil")).toBe(false);
    expect(result.stored).toBe(1);
  });

  it("falls back to storing ALL variants with a console.warn when the printing is absent", async () => {
    scrydexMock.fetchScrydexPriceHistory.mockResolvedValueOnce(mixedRawDays());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await pullAndStoreScrydexHistory({
      id: "card_1",
      game: Game.POKEMON,
      scrydexId: SCRYDEX_ID,
      printing: "variantNotInPayload",
    });

    const rows = allWrittenRows();
    // Never store zero when real points exist — keep all three.
    expect(rows).toHaveLength(3);
    expect(result.stored).toBe(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("history printing"));
    warn.mockRestore();
  });

  it("a base row (printing normal) stores the normal-variant points unchanged", async () => {
    scrydexMock.fetchScrydexPriceHistory.mockResolvedValueOnce([
      {
        date: "2026-01-01",
        prices: [{ type: "raw", condition: "NM", variant: "normal", market: 100, currency: "USD" }],
      },
    ]);

    const result = await pullAndStoreScrydexHistory({
      id: "card_base",
      game: Game.POKEMON,
      scrydexId: SCRYDEX_ID,
      // no printing → defaults to "normal"
    });

    const rows = allWrittenRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].variant).toBe("normal");
    expect(result.stored).toBe(1);
  });

  it("scopes the per-grade GRADED series to the printing too", async () => {
    // raw NM call carries only sibling variants (none match), graded call
    // carries the wanted variant — the combined scope keeps graded, drops raw.
    scrydexMock.fetchScrydexPriceHistory
      .mockResolvedValueOnce([
        {
          date: "2026-01-01",
          prices: [{ type: "raw", condition: "NM", variant: "unlimitedHolofoil", market: 300, currency: "USD" }],
        },
      ])
      .mockResolvedValueOnce([
        {
          date: "2026-01-01",
          prices: [{ variant: "unlimitedShadowlessHolofoil", market: 900, currency: "USD" }],
        },
      ]);

    const result = await pullAndStoreScrydexHistory(
      {
        id: "card_1",
        game: Game.POKEMON,
        scrydexId: SCRYDEX_ID,
        printing: "unlimitedShadowlessHolofoil",
      },
      { grades: [{ company: "PSA", grade: "10" }] }
    );

    const rows = allWrittenRows();
    expect(rows.every((r) => r.variant === "unlimitedShadowlessHolofoil")).toBe(true);
    // Only the graded row survived the scope (the raw sibling was dropped).
    expect(rows).toHaveLength(1);
    expect(result.stored).toBe(1);
  });
});
