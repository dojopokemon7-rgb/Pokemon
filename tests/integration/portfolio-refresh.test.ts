import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Phase 2a — POST /api/users/me/portfolio/refresh.
 *
 * On-demand, batched, 24h price refresh for a user's ACTIVE holdings. These
 * tests pin the contract against a MOCKED Prisma + pricing service + credit
 * gate, so NO real HTTP / credits are ever spent:
 *   (a) credits NOT approved → 200 {refreshed:0, reason:"disabled"}, service NOT called;
 *   (b) approved → one pull per DISTINCT active card (deduped), tally refreshed vs
 *       skipped from the mocked {pulled} return, and invalidate the user cache;
 *   (c) sold cards (isSold:true) are excluded by the query filter;
 *   (d) the batch cap (MAX_REFRESH_PER_REQUEST) is respected.
 */

const USER_ID = "user_123";

vi.mock("@/lib/utils/auth-guard", () => ({
  requireAuth: vi.fn(async () => ({ unauthorized: null, session: { user: { id: USER_ID } } })),
}));

const prismaMock = vi.hoisted(() => ({
  userCollection: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const creditGateMock = vi.hoisted(() => ({ isScrydexLiveApproved: vi.fn() }));
vi.mock("@/lib/services/scrydex-credit-gate", () => creditGateMock);

const pricingMock = vi.hoisted(() => ({ pullAndStoreScrydexPrice: vi.fn() }));
vi.mock("@/lib/services/scrydex-pricing.service", () => pricingMock);

const cacheMock = vi.hoisted(() => ({ invalidateUserCaches: vi.fn(async () => undefined) }));
vi.mock("@/lib/utils/cache", () => cacheMock);

import { POST } from "@/app/api/users/me/portfolio/refresh/route";

const req = () => new Request("http://localhost/api/users/me/portfolio/refresh", { method: "POST" });

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
});

describe("POST /api/users/me/portfolio/refresh", () => {
  it("(a) credits NOT approved → safe no-op, no spend", async () => {
    creditGateMock.isScrydexLiveApproved.mockResolvedValue(false);

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ refreshed: 0, skipped: 0, reason: "disabled" });

    // No DB read, no pull, no credit — a true no-op.
    expect(pricingMock.pullAndStoreScrydexPrice).not.toHaveBeenCalled();
    expect(prismaMock.userCollection.findMany).not.toHaveBeenCalled();
  });

  it("(b) approved → one pull per DISTINCT card, tallies refreshed/skipped, invalidates cache", async () => {
    creditGateMock.isScrydexLiveApproved.mockResolvedValue(true);
    // c1 held twice (two collections) → must dedupe to ONE pull. c2 once.
    prismaMock.userCollection.findMany.mockResolvedValue([
      holding("c1"),
      holding("c1"),
      holding("c2"),
    ]);
    // c1 pulled fresh (refreshed), c2 gate-skipped.
    pricingMock.pullAndStoreScrydexPrice.mockImplementation(async (card: { id: string }) => ({
      pulled: card.id === "c1",
      credits: card.id === "c1" ? 1 : 0,
      card: null,
    }));

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ refreshed: 1, skipped: 1, failed: 0 });

    // Deduped: exactly 2 distinct cards pulled, not 3.
    expect(pricingMock.pullAndStoreScrydexPrice).toHaveBeenCalledTimes(2);
    // NO force passed — the built-in 24h gate must stand.
    for (const call of pricingMock.pullAndStoreScrydexPrice.mock.calls) {
      expect(call[1]).toBeUndefined();
    }

    // The scoped query excludes sold cards.
    expect(prismaMock.userCollection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID, isSold: false } })
    );

    // Cache invalidated after the batch.
    expect(cacheMock.invalidateUserCaches).toHaveBeenCalledWith(
      USER_ID,
      expect.arrayContaining(["collection"])
    );
  });

  it("(b.2) a per-card failure is tallied, not fatal", async () => {
    creditGateMock.isScrydexLiveApproved.mockResolvedValue(true);
    prismaMock.userCollection.findMany.mockResolvedValue([holding("c1"), holding("c2")]);
    pricingMock.pullAndStoreScrydexPrice.mockImplementation(async (card: { id: string }) => {
      if (card.id === "c2") throw new Error("boom");
      return { pulled: true, credits: 1, card: null };
    });

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ refreshed: 1, skipped: 0, failed: 1 });
  });

  it("(c) sold cards are excluded by the query filter", async () => {
    creditGateMock.isScrydexLiveApproved.mockResolvedValue(true);
    // Simulate the DB honouring `isSold:false` — only active rows come back.
    prismaMock.userCollection.findMany.mockResolvedValue([holding("active1")]);
    pricingMock.pullAndStoreScrydexPrice.mockResolvedValue({ pulled: true, credits: 1, card: null });

    await POST(req());

    expect(prismaMock.userCollection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ isSold: false }) })
    );
    // Only the one active card was pulled.
    expect(pricingMock.pullAndStoreScrydexPrice).toHaveBeenCalledTimes(1);
  });

  it("(d) the batch cap (100) is respected", async () => {
    creditGateMock.isScrydexLiveApproved.mockResolvedValue(true);
    // 150 distinct active cards → only the first 100 refreshed this request.
    const many = Array.from({ length: 150 }, (_, i) => holding(`c${i}`));
    prismaMock.userCollection.findMany.mockResolvedValue(many);
    pricingMock.pullAndStoreScrydexPrice.mockResolvedValue({ pulled: true, credits: 1, card: null });

    const res = await POST(req());
    expect(await res.json()).toEqual({ refreshed: 100, skipped: 0, failed: 0 });
    expect(pricingMock.pullAndStoreScrydexPrice).toHaveBeenCalledTimes(100);
  });
});
