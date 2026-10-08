import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Daily OWNED-cards current-price refresh service.
 *
 * Pins the contract against a MOCKED Prisma + pricing service + credit gate so
 * NO real HTTP / DB / credits are ever spent:
 *   (a) credits NOT approved → safe no-op (reason:"disabled"), NO DB read, NO
 *       pull, NO summary SyncLog;
 *   (b) owned-set query is ALL-USERS distinct (where:{isSold:false}, NO userId)
 *       and deduped by cardId → one pull per distinct card;
 *   (c) the per-run cap (DAILY_OWNED_PRICE_CAP) bounds pulls;
 *   (d) tallies refreshed/skipped/failed + sums credits, writes ONE summary
 *       SyncLog(job="daily_owned_price");
 *   (e) no Card.marketPrice write happens from this path.
 */

const prismaMock = vi.hoisted(() => ({
  userCollection: { findMany: vi.fn<(args: { where: Record<string, unknown> }) => Promise<unknown[]>>() },
  syncLog: {
    create: vi.fn<(args: { data: Record<string, unknown> }) => Promise<unknown>>(async () => ({})),
  },
  card: { update: vi.fn(async () => ({})) },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const creditGateMock = vi.hoisted(() => ({ isScrydexLiveApproved: vi.fn() }));
vi.mock("@/lib/services/scrydex-credit-gate", () => creditGateMock);

const pricingMock = vi.hoisted(() => ({ pullAndStoreScrydexPrice: vi.fn() }));
vi.mock("@/lib/services/scrydex-pricing.service", () => pricingMock);

import {
  getOwnedCardsForRefresh,
  refreshOwnedPrices,
} from "@/lib/services/owned-price-refresh.service";

// A holding row as returned by the scoped findMany (only the nested card select).
function holding(id: string) {
  return {
    card: {
      id,
      externalId: `ext-${id}`,
      name: `Card ${id}`,
      number: "1",
      game: "POKEMON",
      scrydexId: `sx-${id}`,
      set: { name: "Base" },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.DAILY_OWNED_PRICE_CAP;
});

afterEach(() => {
  delete process.env.DAILY_OWNED_PRICE_CAP;
});

describe("getOwnedCardsForRefresh", () => {
  it("queries ALL-USERS active holdings (isSold:false, NO userId) and dedupes by cardId", async () => {
    // c1 held twice (two users / collections) → one entry. c2 once.
    prismaMock.userCollection.findMany.mockResolvedValue([
      holding("c1"),
      holding("c1"),
      holding("c2"),
    ]);

    const owned = await getOwnedCardsForRefresh();

    expect(owned.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    // Mapped to ScrydexPullCard with both ids (two-id rule).
    expect(owned.find((c) => c.id === "c1")).toMatchObject({
      id: "c1",
      externalId: "ext-c1",
      scrydexId: "sx-c1",
      setName: "Base",
    });

    const call = prismaMock.userCollection.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ isSold: false });
    // NOT user-scoped — this is the union across every user.
    expect(call.where).not.toHaveProperty("userId");
  });

  it("skips rows with a null card", async () => {
    prismaMock.userCollection.findMany.mockResolvedValue([
      { card: null },
      holding("c1"),
    ]);
    const owned = await getOwnedCardsForRefresh();
    expect(owned.map((c) => c.id)).toEqual(["c1"]);
  });
});

describe("refreshOwnedPrices", () => {
  it("(a) credits NOT approved → safe no-op, no DB read, no pull, no summary log", async () => {
    creditGateMock.isScrydexLiveApproved.mockResolvedValue(false);

    const summary = await refreshOwnedPrices();

    expect(summary).toEqual({
      reason: "disabled",
      owned: 0,
      attempted: 0,
      refreshed: 0,
      skipped: 0,
      failed: 0,
      credits: 0,
    });
    expect(prismaMock.userCollection.findMany).not.toHaveBeenCalled();
    expect(pricingMock.pullAndStoreScrydexPrice).not.toHaveBeenCalled();
    expect(prismaMock.syncLog.create).not.toHaveBeenCalled();
  });

  it("(b) approved → one pull per DISTINCT owned card, no force passed", async () => {
    creditGateMock.isScrydexLiveApproved.mockResolvedValue(true);
    prismaMock.userCollection.findMany.mockResolvedValue([
      holding("c1"),
      holding("c1"),
      holding("c2"),
    ]);
    pricingMock.pullAndStoreScrydexPrice.mockResolvedValue({
      pulled: true,
      credits: 1,
      card: null,
    });

    await refreshOwnedPrices();

    expect(pricingMock.pullAndStoreScrydexPrice).toHaveBeenCalledTimes(2);
    for (const call of pricingMock.pullAndStoreScrydexPrice.mock.calls) {
      expect(call[1]).toBeUndefined(); // NO force — the 24h gate must stand
    }
  });

  it("(c) the per-run cap (DAILY_OWNED_PRICE_CAP) bounds pulls", async () => {
    process.env.DAILY_OWNED_PRICE_CAP = "2";
    creditGateMock.isScrydexLiveApproved.mockResolvedValue(true);
    const many = Array.from({ length: 5 }, (_, i) => holding(`c${i}`));
    prismaMock.userCollection.findMany.mockResolvedValue(many);
    pricingMock.pullAndStoreScrydexPrice.mockResolvedValue({
      pulled: true,
      credits: 1,
      card: null,
    });

    const summary = await refreshOwnedPrices();

    expect(pricingMock.pullAndStoreScrydexPrice).toHaveBeenCalledTimes(2);
    expect(summary.owned).toBe(5);
    expect(summary.attempted).toBe(2);
  });

  it("(d) tallies refreshed/skipped/failed, sums credits, writes ONE summary SyncLog", async () => {
    creditGateMock.isScrydexLiveApproved.mockResolvedValue(true);
    prismaMock.userCollection.findMany.mockResolvedValue([
      holding("c1"),
      holding("c2"),
      holding("c3"),
    ]);
    pricingMock.pullAndStoreScrydexPrice.mockImplementation(
      async (card: { id: string }) => {
        if (card.id === "c1") return { pulled: true, credits: 1, card: null };
        if (card.id === "c2") return { pulled: false, credits: 0, card: null };
        throw new Error("boom");
      }
    );

    const summary = await refreshOwnedPrices();

    expect(summary).toMatchObject({
      owned: 3,
      attempted: 3,
      refreshed: 1,
      skipped: 1,
      failed: 1,
      credits: 1,
    });
    expect(prismaMock.syncLog.create).toHaveBeenCalledTimes(1);
    const data = prismaMock.syncLog.create.mock.calls[0][0].data;
    expect(data.job).toBe("daily_owned_price");
    expect(data.status).toBe("ok");
    expect(data.credits).toBe(1);
    expect(data.error).toContain("summary:");
    expect(data.error).toContain("owned=3");
    expect(data.error).toContain("refreshed=1");
    expect(data.error).toContain("failed=1");
  });

  it("(e) never writes Card.marketPrice from this path", async () => {
    creditGateMock.isScrydexLiveApproved.mockResolvedValue(true);
    prismaMock.userCollection.findMany.mockResolvedValue([holding("c1")]);
    pricingMock.pullAndStoreScrydexPrice.mockResolvedValue({
      pulled: true,
      credits: 1,
      card: null,
    });

    await refreshOwnedPrices();

    // The daily routine delegates all writes to pullAndStoreScrydexPrice (which
    // writes CurrentPrice, not marketPrice). It must never update Card itself.
    expect(prismaMock.card.update).not.toHaveBeenCalled();
  });
});
