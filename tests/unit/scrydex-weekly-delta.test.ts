import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Game } from "@prisma/client";

/**
 * Unit test for the ON-VIEW per-printing weekly-delta writer
 * (pullAndStoreScrydexWeeklyDelta). Proves:
 *   (1) it writes the printing's OWN real trends.days_7 delta;
 *   (2) a variant with no trend leaves weeklyChange* NULL (no fabrication);
 *   (3) a sibling variant's trend is NEVER written onto this printing
 *       (printing-scoped — RULE 3).
 *
 * ZERO real Scrydex credits: fetchScrydexCardById is mocked, and BOTH gate flags
 * stay off. The on-view gate is authorized by the REAL assertScrydexEnrichApproved
 * (setting SCRYDEX_ONVIEW_ENABLED + passing creditAuth:"onview") — not mocked —
 * so the gate contract is exercised honestly. No HTTP, no live DB.
 */

const scrydexMock = vi.hoisted(() => ({ fetchScrydexCardById: vi.fn() }));
vi.mock("@/lib/services/scrydex.service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/services/scrydex.service")>(
    "@/lib/services/scrydex.service"
  );
  // Keep the real pure accessors (pickRawPrice) + types; only stub the fetch.
  return { ...actual, fetchScrydexCardById: scrydexMock.fetchScrydexCardById };
});

const prismaMock = vi.hoisted(() => ({
  card: { update: vi.fn() },
  syncLog: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

// Redis is only pulled in transitively by the credit gate's soft path; stub it
// so an unreachable Redis never surfaces (the on-view gate is env-only anyway).
vi.mock("@/lib/redis", () => ({
  redis: { get: vi.fn().mockResolvedValue(null), del: vi.fn() },
  RedisKeys: { scrydexCreditApproval: "scrydex:credit-approval" },
}));

import { pullAndStoreScrydexWeeklyDelta } from "@/lib/services/scrydex-pricing.service";

// Build a minimal ScrydexCard with raw price entries + trends per variant.
function cardWithVariants(
  variants: Array<{
    name: string;
    trends?: { price_change?: number | null; percent_change?: number | null } | null;
  }>
) {
  return {
    id: "me55c-4",
    name: "Charizard",
    number: "4",
    variants: variants.map((v) => ({
      name: v.name,
      images: null,
      prices: [
        {
          type: "raw",
          condition: "NM",
          grade: null,
          company: null,
          low: 10,
          market: 100,
          currency: "USD",
          trends:
            v.trends === undefined
              ? undefined
              : v.trends === null
                ? null
                : { days_1: null, days_7: v.trends, days_14: null },
        },
      ],
    })),
  };
}

const TWO_VARIANTS = () =>
  cardWithVariants([
    { name: "normal", trends: { price_change: 1, percent_change: 2 } },
    { name: "alt art", trends: { price_change: 9, percent_change: 9 } },
  ]);

beforeEach(() => {
  vi.clearAllMocks();
  // Authorize the on-view gate via the REAL assertScrydexEnrichApproved — no
  // bulk gate opened, no credits spent (fetch is mocked).
  process.env.SCRYDEX_ONVIEW_ENABLED = "true";
  delete process.env.SCRYDEX_LIVE_CREDITS_APPROVED;
  prismaMock.card.update.mockResolvedValue({});
  prismaMock.syncLog.create.mockResolvedValue({});
});

afterEach(() => {
  delete process.env.SCRYDEX_ONVIEW_ENABLED;
  delete process.env.SCRYDEX_LIVE_CREDITS_APPROVED;
});

describe("pullAndStoreScrydexWeeklyDelta", () => {
  it("(1) writes the printing's OWN real trends.days_7 delta", async () => {
    scrydexMock.fetchScrydexCardById.mockResolvedValue(TWO_VARIANTS());

    const r = await pullAndStoreScrydexWeeklyDelta(
      { id: "card_alt", game: Game.POKEMON, scrydexId: "me55c-4", printing: "alt art" },
      { creditAuth: "onview" }
    );

    expect(r.written).toBe(true);
    expect(prismaMock.card.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.card.update).toHaveBeenCalledWith({
      where: { id: "card_alt" },
      data: { weeklyChangeAbs: 9, weeklyChangePct: 9 },
    });
  });

  it("(2) a variant with no trend leaves weeklyChange* NULL (no fabrication)", async () => {
    scrydexMock.fetchScrydexCardById.mockResolvedValue(
      cardWithVariants([{ name: "normal", trends: null }])
    );

    const r = await pullAndStoreScrydexWeeklyDelta(
      { id: "card_base", game: Game.POKEMON, scrydexId: "me55c-4", printing: null },
      { creditAuth: "onview" }
    );

    expect(r.written).toBe(false);
    // Columns left untouched — NO {weeklyChange*: 0} write.
    expect(prismaMock.card.update).not.toHaveBeenCalled();
  });

  it("(3) printing-scoped: a sibling variant's trend is NOT written onto this printing", async () => {
    scrydexMock.fetchScrydexCardById.mockResolvedValue(TWO_VARIANTS());

    const r = await pullAndStoreScrydexWeeklyDelta(
      { id: "card_base", game: Game.POKEMON, scrydexId: "me55c-4", printing: "normal" },
      { creditAuth: "onview" }
    );

    expect(r.written).toBe(true);
    // The normal row gets {1,2} — the alt-art {9,9} is NEVER written here.
    expect(prismaMock.card.update).toHaveBeenCalledWith({
      where: { id: "card_base" },
      data: { weeklyChangeAbs: 1, weeklyChangePct: 2 },
    });
  });

  it("a printing absent from the payload writes nothing (no all-variants fallback)", async () => {
    scrydexMock.fetchScrydexCardById.mockResolvedValue(TWO_VARIANTS());

    const r = await pullAndStoreScrydexWeeklyDelta(
      { id: "card_missing", game: Game.POKEMON, scrydexId: "me55c-4", printing: "reverse holofoil" },
      { creditAuth: "onview" }
    );

    expect(r.written).toBe(false);
    expect(prismaMock.card.update).not.toHaveBeenCalled();
  });
});
