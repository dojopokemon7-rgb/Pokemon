import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Redis-down fall-through (AGENTS.md RULE 1 — Redis is fail-open).
 *
 * When redis.get THROWS (Redis offline/timeout), the cached read routes must
 * still return 200 with the LIVE Prisma-derived payload — the cache failure
 * neither blocks nor alters the response, and the handler never throws.
 *
 * Covers a per-user route (GET /api/users/me/collection) and a user-agnostic
 * card-detail route (GET /api/cards/[id]/prices). Prisma + ioredis are mocked
 * (no live DB/network).
 */

const USER_ID = "user_123";

vi.mock("@/lib/utils/auth-guard", () => ({
  requireAuth: vi.fn(async () => ({
    unauthorized: null,
    session: { user: { id: USER_ID } },
  })),
}));

const prismaMock = vi.hoisted(() => ({
  userCollection: { findMany: vi.fn() },
  card: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

// Simulate Redis-down: EVERY op rejects. The fail-open helpers must swallow
// these so the live query result is returned unchanged.
const redisMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  keys: vi.fn(),
}));
vi.mock("@/lib/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/redis")>();
  return { ...actual, redis: redisMock };
});

import { GET as collectionGet } from "@/app/api/users/me/collection/route";
import { GET as pricesGet } from "@/app/api/cards/[id]/prices/route";

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockRejectedValue(new Error("ECONNREFUSED")); // Redis down
  redisMock.set.mockRejectedValue(new Error("ECONNREFUSED"));
});

describe("GET /api/users/me/collection — Redis down", () => {
  it("returns 200 with the live DB rows (cache failure does not block)", async () => {
    const rows = [
      { id: "uc_1", cardId: "c1", quantity: 2, card: { externalId: "base1-4", name: "Charizard" } },
    ];
    prismaMock.userCollection.findMany.mockResolvedValue(rows);

    const res = await collectionGet(
      new Request("http://localhost/api/users/me/collection")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items).toEqual(rows);
    expect(prismaMock.userCollection.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/cards/[id]/prices — Redis down", () => {
  it("returns 200 with the live stored prices (cache failure does not block)", async () => {
    prismaMock.card.findUnique.mockResolvedValue({
      currentPrices: [{ id: "p1", priceMarket: 10 }],
      weeklyChangePct: 1.5,
    });

    const res = await pricesGet(new Request("http://localhost/api/cards/base1-4/prices"), {
      params: Promise.resolve({ id: "base1-4" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.prices).toEqual([{ id: "p1", priceMarket: 10 }]);
    expect(body.weeklyChangePct).toBe(1.5);
    expect(prismaMock.card.findUnique).toHaveBeenCalledTimes(1);
  });
});
