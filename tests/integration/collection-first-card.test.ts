import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * first_card_added contract: POST /api/users/me/collection reports
 * `firstCard: true` ONLY when the user owned zero collection rows (active or
 * sold) before the request AND at least one card was really added. Prisma MOCKED.
 */
const prismaMock = vi.hoisted(() => ({
  collection: { findMany: vi.fn(), create: vi.fn() },
  userCollection: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  cardSet: { upsert: vi.fn() },
  card: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  pricingHistory: { createMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/utils/auth-guard", () => ({
  requireAuth: vi.fn(async () => ({ unauthorized: null, session: { user: { id: "user_1" } } })),
}));
vi.mock("@/lib/utils/cache", () => ({
  cacheGetJson: vi.fn(async () => null),
  cacheSetJson: vi.fn(async () => undefined),
  invalidateUserCaches: vi.fn(async () => undefined),
}));

import { POST } from "@/app/api/users/me/collection/route";

const post = (cards: unknown[], extra: Record<string, unknown> = {}) =>
  POST(new Request("http://localhost/api/users/me/collection", { method: "POST", body: JSON.stringify({ cards, ...extra }) }));
const card = { externalId: "base1-4", name: "Charizard", quantity: 1 };

beforeEach(() => {
  vi.resetAllMocks();
  prismaMock.collection.findMany.mockResolvedValue([{ id: "col_main", name: "Main" }]);
  prismaMock.collection.create.mockResolvedValue({ id: "col_main", name: "Main" });
  prismaMock.cardSet.upsert.mockResolvedValue({ id: "set_1" });
  prismaMock.card.findFirst.mockResolvedValue({ id: "c1", externalId: "base1-4", marketPrice: 10 });
  prismaMock.pricingHistory.createMany.mockResolvedValue({});
  prismaMock.userCollection.findMany.mockResolvedValue([]);
  prismaMock.userCollection.create.mockResolvedValue({ id: "uc" });
});

describe("POST /api/users/me/collection — firstCard flag", () => {
  it("true when the user had zero rows and a card was added", async () => {
    prismaMock.userCollection.count.mockResolvedValue(0);
    const json = await (await post([card])).json();
    expect(json.firstCard).toBe(true);
    expect(prismaMock.userCollection.count).toHaveBeenCalledWith({ where: { userId: "user_1" } });
  });

  it("false when the user already owned rows", async () => {
    prismaMock.userCollection.count.mockResolvedValue(3);
    expect((await (await post([card])).json()).firstCard).toBe(false);
  });

  it("false when nothing was actually added (already present + skip)", async () => {
    prismaMock.userCollection.count.mockResolvedValue(0);
    prismaMock.userCollection.findMany.mockResolvedValue([{ id: "uc_x", condition: null, quantity: 1 }]);
    const json = await (await post([card], { onExisting: "skip" })).json();
    expect(json.added).toBe(0);
    expect(json.firstCard).toBe(false);
  });

  it("false (never claims a first it did not observe) when the count query fails", async () => {
    prismaMock.userCollection.count.mockRejectedValue(new Error("db"));
    const res = await post([card]);
    expect(res.status).toBe(200);
    expect((await res.json()).firstCard).toBe(false);
  });
});
