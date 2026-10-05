import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * SECURITY (price fabrication / shared-catalog override) — the add-to-collection
 * POST must NEVER write a client-supplied `marketPrice` into a SHARED catalog
 * row (Card.marketPrice / lastPricedAt) or into the SHARED pricing_history (the
 * chart every user sees). RULE 2 (never fabricate data) + the global-vs-per-user
 * split: Card + pricing_history are GLOBAL, user_collection is per-user.
 *
 * The user's OWN cost basis (explicit purchasePrice on their user_collection
 * row) is legitimate and must still work. Prisma is MOCKED (no live DB/network),
 * same pattern as collection-add-ownership.test.ts.
 */

const prismaMock = vi.hoisted(() => ({
  collection: { findMany: vi.fn(), create: vi.fn() },
  userCollection: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  cardSet: { upsert: vi.fn() },
  card: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  pricingHistory: { createMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const USER_ID = "user_123";
vi.mock("@/lib/utils/auth-guard", () => ({
  requireAuth: vi.fn(async () => ({ unauthorized: null, session: { user: { id: USER_ID } } })),
}));

vi.mock("@/lib/utils/cache", () => ({
  cacheGetJson: vi.fn(async () => null),
  cacheSetJson: vi.fn(async () => undefined),
  invalidateUserCaches: vi.fn(async () => undefined),
}));

import { POST as collectionAddPOST } from "@/app/api/users/me/collection/route";

// Existing catalog card with a REAL price of $10 (the shared truth).
const EXISTING_CARD = { id: "card_1", externalId: "base1-4", marketPrice: 10 };
const MAIN = { id: "col_main", name: "Main" };

function addBody(cards: unknown[]) {
  return new Request("http://localhost/api/users/me/collection", {
    method: "POST",
    body: JSON.stringify({ cards }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.collection.findMany.mockResolvedValue([MAIN]);
  prismaMock.cardSet.upsert.mockResolvedValue({ id: "set_1" });
  prismaMock.card.findFirst.mockResolvedValue(EXISTING_CARD);
  prismaMock.card.create.mockResolvedValue(EXISTING_CARD);
  prismaMock.card.update.mockResolvedValue(EXISTING_CARD);
  prismaMock.pricingHistory.createMany.mockResolvedValue({});
  prismaMock.userCollection.findMany.mockResolvedValue([]);
  prismaMock.userCollection.create.mockResolvedValue({ id: "uc_1" });
});

describe("POST /api/users/me/collection — no shared-catalog price fabrication", () => {
  it("a crafted marketPrice NEVER mutates the shared Card row (no card.update with marketPrice)", async () => {
    const res = await collectionAddPOST(
      addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1, marketPrice: 999999 }])
    );
    expect((await res.json()).added).toBe(1);

    // The existing-card branch must not update ANY shared field from user input.
    // (If card.update were ever called, it must not carry a marketPrice.)
    for (const call of prismaMock.card.update.mock.calls) {
      expect(call[0]?.data?.marketPrice).toBeUndefined();
    }
    // Prefer the surgical fix: no shared-row mutation on add at all.
    expect(prismaMock.card.update).not.toHaveBeenCalled();
  });

  it("a crafted marketPrice NEVER lands in the shared pricing_history", async () => {
    await collectionAddPOST(
      addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1, marketPrice: 999999 }])
    );

    // A snapshot row may still be written using the REAL catalog price ($10),
    // but NEVER with the user-supplied 999999.
    for (const call of prismaMock.pricingHistory.createMany.mock.calls) {
      for (const row of call[0].data) {
        expect(row.priceMarket).not.toBe(999999);
      }
    }
    // The one add-snapshot that IS written reflects the real catalog price.
    const rows = prismaMock.pricingHistory.createMany.mock.calls.flatMap((c) => c[0].data);
    expect(rows.some((r: { priceMarket: number }) => r.priceMarket === 10)).toBe(true);
  });

  it("a brand-new user-added card is created with a NULL price (never from client input)", async () => {
    prismaMock.card.findFirst.mockResolvedValueOnce(null); // not in catalog
    prismaMock.card.create.mockResolvedValueOnce({ id: "card_new", externalId: "op99-999", marketPrice: null });

    await collectionAddPOST(
      addBody([{ externalId: "op99-999", name: "Mystery", quantity: 1, marketPrice: 999999 }])
    );

    const createData = prismaMock.card.create.mock.calls[0][0].data;
    expect(createData.marketPrice).toBeNull();
    expect(createData.lastPricedAt).toBeNull();
  });

  it("an EXPLICIT purchasePrice is still honored on the user's OWN collection row", async () => {
    await collectionAddPOST(
      addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1, purchasePrice: 42 }])
    );

    const data = prismaMock.userCollection.create.mock.calls[0][0].data;
    expect(data.purchasePrice).toBe(42);
    expect(data.costBasisSource).toBe("user");
  });

  it("with no purchasePrice, the cost-basis snapshot uses the REAL catalog price, not a crafted marketPrice", async () => {
    await collectionAddPOST(
      addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1, marketPrice: 999999 }])
    );

    const data = prismaMock.userCollection.create.mock.calls[0][0].data;
    expect(data.purchasePrice).toBe(10); // real card.marketPrice, NOT 999999
    expect(data.costBasisSource).toBe("add-snapshot");
  });
});
