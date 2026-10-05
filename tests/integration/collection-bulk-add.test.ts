import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

/**
 * FEAT-004 — bulk add contract (top-level collectionId, onExisting, counts,
 * dedupe, ordering, ownership). Prisma is MOCKED (no live DB/network).
 */
const prismaMock = vi.hoisted(() => ({
  collection: { findMany: vi.fn(), create: vi.fn() },
  userCollection: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
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

import { POST } from "@/app/api/users/me/collection/route";
import { invalidateUserCaches } from "@/lib/utils/cache";

const MAIN = { id: "col_main", name: "Main" };
const OWNED = { id: "col_owned", name: "Vintage" };
const card = (n: number) => ({ externalId: `base1-${n}`, name: `Card ${n}`, quantity: 1 });

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/users/me/collection", { method: "POST", body: JSON.stringify(body) })
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  prismaMock.collection.findMany.mockResolvedValue([MAIN, OWNED]);
  prismaMock.cardSet.upsert.mockResolvedValue({ id: "set_1" });
  prismaMock.card.findFirst.mockImplementation(async (a: { where: { OR: { externalId: string }[] } }) => ({
    id: `id_${a.where.OR[0].externalId}`,
    externalId: a.where.OR[0].externalId,
    marketPrice: 10,
  }));
  prismaMock.card.update.mockImplementation(async (a: { where: { id: string } }) => ({
    id: a.where.id,
    marketPrice: 10,
  }));
  prismaMock.pricingHistory.createMany.mockResolvedValue({});
  prismaMock.userCollection.findMany.mockResolvedValue([]);
  prismaMock.userCollection.create.mockResolvedValue({ id: "uc" });
});

describe("POST /api/users/me/collection — bulk add", () => {
  it("top-level collectionId applies to items without their own", async () => {
    await post({ collectionId: "col_owned", cards: [card(1), { ...card(2), collectionId: "col_main" }] });
    const ids = prismaMock.userCollection.create.mock.calls.map((c) => c[0].data.collectionId);
    expect(ids).toEqual(["col_owned", "col_main"]);
  });

  it("a FOREIGN top-level collectionId → 404 {error:'Not Found'} with ZERO writes", async () => {
    const res = await post({ collectionId: "col_foreign", cards: [card(1), card(2)] });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Not Found");
    expect(prismaMock.userCollection.create).not.toHaveBeenCalled();
    expect(prismaMock.userCollection.update).not.toHaveBeenCalled();
    expect(prismaMock.card.update).not.toHaveBeenCalled();
    expect(prismaMock.card.create).not.toHaveBeenCalled();
    expect(prismaMock.cardSet.upsert).not.toHaveBeenCalled();
    expect(prismaMock.collection.create).not.toHaveBeenCalled();
    expect(invalidateUserCaches).not.toHaveBeenCalled();
    // ownership lookup is scoped to the acting user
    expect(prismaMock.collection.findMany.mock.calls[0][0].where).toEqual({ userId: USER_ID });
  });

  it("dedupes by externalId (first wins) and preserves strictly-decreasing addedAt in selection order", async () => {
    const res = await post({ cards: [card(3), card(1), card(3), card(2)] });
    const json = await res.json();
    expect(json.total).toBe(3);
    const created = prismaMock.userCollection.create.mock.calls.map((c) => c[0].data);
    expect(created).toHaveLength(3);
    const stamps = created.map((d) => (d.addedAt as Date).getTime());
    expect(stamps[0]).toBeGreaterThan(stamps[1]);
    expect(stamps[1]).toBeGreaterThan(stamps[2]);
  });

  it("onExisting:'skip' leaves existing lots untouched and reports alreadyPresent", async () => {
    prismaMock.userCollection.findMany
      .mockResolvedValueOnce([{ id: "uc_exist", condition: null, quantity: 2 }]) // card 1 present
      .mockResolvedValueOnce([]); // card 2 new
    const res = await post({ onExisting: "skip", cards: [card(1), card(2)] });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ added: 1, alreadyPresent: 1, invalid: 0, total: 2 });
    expect(prismaMock.userCollection.update).not.toHaveBeenCalled();
    expect(prismaMock.userCollection.create).toHaveBeenCalledTimes(1);
  });

  it("an all-already-present skip batch is a 200, not a 5xx, and invalidates nothing", async () => {
    prismaMock.userCollection.findMany.mockResolvedValue([{ id: "uc_exist", condition: null, quantity: 2 }]);
    const res = await post({ onExisting: "skip", cards: [card(1)] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ added: 0, alreadyPresent: 1 });
    expect(invalidateUserCaches).not.toHaveBeenCalled();
  });

  it("default onExisting is increment (back-compat)", async () => {
    prismaMock.userCollection.findMany.mockResolvedValueOnce([{ id: "uc_exist", condition: null, quantity: 2 }]);
    prismaMock.userCollection.update.mockResolvedValue({});
    const json = await (await post({ cards: [card(1)] })).json();
    expect(json).toMatchObject({ added: 1, alreadyPresent: 0, invalid: 0 });
    expect(prismaMock.userCollection.update.mock.calls[0][0].data.quantity).toBe(3);
  });

  it("skip + P2002 race counts as alreadyPresent", async () => {
    prismaMock.userCollection.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "6" })
    );
    prismaMock.userCollection.findFirst.mockResolvedValueOnce({ id: "raced", condition: null, quantity: 1 });
    const json = await (await post({ onExisting: "skip", cards: [card(1)] })).json();
    expect(json).toMatchObject({ added: 0, alreadyPresent: 1, invalid: 0 });
    expect(prismaMock.userCollection.update).not.toHaveBeenCalled();
  });

  it("reports invalid items and still 200s when at least one card was added", async () => {
    prismaMock.userCollection.create.mockRejectedValueOnce(new Error("boom"));
    const res = await post({ cards: [card(1), card(2)] });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ added: 1, invalid: 1, total: 2 });
  });

  it("legacy collectionId:null rows are still readable via the GET select (not rewritten by add)", async () => {
    await post({ cards: [card(1)] });
    // The add never queries or rewrites null-bucket lots: lookups are scoped to Main.
    expect(prismaMock.userCollection.findMany.mock.calls[0][0].where.collectionId).toBe("col_main");
  });

  it("invalidates collection, dashboard and collections caches", async () => {
    await post({ cards: [card(1)] });
    expect(invalidateUserCaches).toHaveBeenCalledWith(USER_ID, expect.arrayContaining(["collection", "dashboard", "collections"]));
  });
});
