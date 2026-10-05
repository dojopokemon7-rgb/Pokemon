import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * FIX D (sec-audit, RULE 4) — routes that early-return a Redis-cached blob must
 * re-parse it with their OUTPUT Zod schema and treat a WRONG-shape blob as a
 * cache MISS (fall through to the live DB path), never serve it.
 *
 * Covered here (two routes, as required): GET /api/cards/[id]/prices and
 * GET /api/collections. Prisma + the collections service are mocked so the
 * "fall through to live" path is observable (the mocked query runs + returns
 * the fresh shape, and the stale blob is NOT echoed).
 */

const prismaMock = vi.hoisted(() => ({
  card: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const cacheMock = vi.hoisted(() => ({
  cacheGetJson: vi.fn(async (): Promise<unknown> => null),
  cacheSetJson: vi.fn(async () => undefined),
  invalidateUserCaches: vi.fn(async () => undefined),
}));
vi.mock("@/lib/utils/cache", () => cacheMock);

vi.mock("@/lib/utils/auth-guard", () => ({
  requireAuth: vi.fn(async () => ({ unauthorized: null, session: { user: { id: "u1" } } })),
}));

const collectionsSvcMock = vi.hoisted(() => ({
  listCollectionsWithBuckets: vi.fn(),
  createCollection: vi.fn(),
  VirtualCollectionReadonlyError: class extends Error {},
  MainCollectionProtectedError: class extends Error {},
}));
vi.mock("@/lib/services/collection.service", () => collectionsSvcMock);

import { GET as pricesGET } from "@/app/api/cards/[id]/prices/route";
import { GET as collectionsGET } from "@/app/api/collections/route";

beforeEach(() => {
  vi.clearAllMocks();
  cacheMock.cacheGetJson.mockResolvedValue(null);
});

describe("GET /api/cards/[id]/prices — re-validate cached read (FIX D)", () => {
  it("treats a WRONG-shape cached blob as a miss and serves the live DB result", async () => {
    // Stale/old-shape blob: `prices` is not an array, `weeklyChangePct` missing.
    cacheMock.cacheGetJson.mockResolvedValue({ prices: "nope" });
    prismaMock.card.findUnique.mockResolvedValue({
      currentPrices: [{ id: "cp1" }],
      weeklyChangePct: 4.2,
    });

    const res = await pricesGET(new Request("http://localhost/api/cards/base1-4/prices"), {
      params: Promise.resolve({ id: "base1-4" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    // Fell through to the live query (the stale blob was NOT served).
    expect(prismaMock.card.findUnique).toHaveBeenCalled();
    expect(body.weeklyChangePct).toBe(4.2);
    expect(body.prices).toEqual([{ id: "cp1" }]);
  });

  it("serves a VALID cached blob without hitting the DB", async () => {
    cacheMock.cacheGetJson.mockResolvedValue({ prices: [{ id: "cached" }], weeklyChangePct: null });

    const res = await pricesGET(new Request("http://localhost/api/cards/base1-4/prices"), {
      params: Promise.resolve({ id: "base1-4" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(prismaMock.card.findUnique).not.toHaveBeenCalled();
    expect(body.prices).toEqual([{ id: "cached" }]);
  });
});

describe("GET /api/collections — re-validate cached read (FIX D)", () => {
  it("treats a WRONG-shape cached blob as a miss and serves the live list", async () => {
    // Old-shape blob: items missing the required id/name fields.
    cacheMock.cacheGetJson.mockResolvedValue({ data: [{ foo: "bar" }] });
    collectionsSvcMock.listCollectionsWithBuckets.mockResolvedValue([
      { id: "c1", name: "Main", buckets: {} },
    ]);

    const res = await collectionsGET(new Request("http://localhost/api/collections"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(collectionsSvcMock.listCollectionsWithBuckets).toHaveBeenCalled();
    expect(body.data).toEqual([{ id: "c1", name: "Main", buckets: {} }]);
  });

  it("serves a VALID cached blob without calling the service", async () => {
    cacheMock.cacheGetJson.mockResolvedValue({ data: [{ id: "c1", name: "Main" }] });

    const res = await collectionsGET(new Request("http://localhost/api/collections"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(collectionsSvcMock.listCollectionsWithBuckets).not.toHaveBeenCalled();
    expect(body.data).toEqual([{ id: "c1", name: "Main" }]);
  });
});
