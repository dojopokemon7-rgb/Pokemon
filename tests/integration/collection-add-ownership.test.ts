import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * FEAT-003/004 — server-side ownership on the add-to-collection POST. Prisma is
 * MOCKED (no live DB/network).
 *
 *   - AC-17: an OWNED collectionId is honored verbatim on create/update.
 *   - FEAT-004: no collectionId, or a FOREIGN per-item id, files under the
 *     user's MAIN (never another user's, never a 4xx, no id leak).
 *   - fast path: with no collectionId anywhere only the Main lookup runs
 *     (no owned-ids query with a select).
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

// Redis cache helpers are no-ops here (Redis is optional / cache-only).
vi.mock("@/lib/utils/cache", () => ({
  cacheGetJson: vi.fn(async () => null),
  cacheSetJson: vi.fn(async () => undefined),
  invalidateUserCaches: vi.fn(async () => undefined),
}));

import { POST as collectionAddPOST } from "@/app/api/users/me/collection/route";
import { invalidateUserCaches } from "@/lib/utils/cache";

const CARD = { id: "card_1", externalId: "base1-4", marketPrice: 10 };
const MAIN = { id: "col_main", name: "Main" };
const OWNED = { id: "col_owned", name: "Vintage" };

function addBody(cards: unknown[]) {
  return new Request("http://localhost/api/users/me/collection", {
    method: "POST",
    body: JSON.stringify({ cards }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.collection.findMany.mockResolvedValue([MAIN, OWNED]);
  prismaMock.cardSet.upsert.mockResolvedValue({ id: "set_1" });
  prismaMock.card.findFirst.mockResolvedValue(CARD);
  prismaMock.card.update.mockResolvedValue(CARD);
  prismaMock.pricingHistory.createMany.mockResolvedValue({});
});

describe("POST /api/users/me/collection — ownership + Main default", () => {
  it("files a FOREIGN per-item collectionId under the user's MAIN, never the foreign id", async () => {
    prismaMock.userCollection.findMany.mockResolvedValueOnce([]);
    prismaMock.userCollection.create.mockResolvedValueOnce({ id: "uc_1" });

    const res = await collectionAddPOST(
      addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1, collectionId: "col_foreign" }])
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.added).toBe(1);
    expect(prismaMock.userCollection.create.mock.calls[0][0].data.collectionId).toBe("col_main");
    expect(prismaMock.userCollection.findMany.mock.calls[0][0].where.collectionId).toBe("col_main");
    expect(JSON.stringify(json)).not.toContain("col_foreign");
  });

  it("files an OWNED collectionId under that id (AC-17)", async () => {
    prismaMock.userCollection.findMany.mockResolvedValueOnce([]);
    prismaMock.userCollection.create.mockResolvedValueOnce({ id: "uc_1" });

    const res = await collectionAddPOST(
      addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1, collectionId: "col_owned" }])
    );

    expect((await res.json()).added).toBe(1);
    expect(prismaMock.userCollection.create.mock.calls[0][0].data.collectionId).toBe("col_owned");
  });

  it("honors an OWNED collectionId on the increment (update) path (AC-17)", async () => {
    prismaMock.userCollection.findMany.mockResolvedValueOnce([
      { id: "uc_existing", condition: null, quantity: 1 },
    ]);
    prismaMock.userCollection.update.mockResolvedValueOnce({ id: "uc_existing", quantity: 2 });

    await collectionAddPOST(
      addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1, collectionId: "col_owned" }])
    );

    expect(prismaMock.userCollection.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.userCollection.update.mock.calls[0][0].data.collectionId).toBe("col_owned");
  });

  it("no collectionId anywhere → files under the user's existing Main (no owned-ids select query)", async () => {
    prismaMock.userCollection.findMany.mockResolvedValueOnce([]);
    prismaMock.userCollection.create.mockResolvedValueOnce({ id: "uc_1" });

    await collectionAddPOST(addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1 }]));

    expect(prismaMock.collection.create).not.toHaveBeenCalled(); // Main already existed
    for (const call of prismaMock.collection.findMany.mock.calls) {
      expect(call[0].select).toBeUndefined();
      expect(call[0].where).toEqual({ userId: USER_ID }); // owner-scoped
    }
    expect(prismaMock.userCollection.create.mock.calls[0][0].data.collectionId).toBe("col_main");
  });

  it("lazily creates Main when the user has none", async () => {
    prismaMock.collection.findMany.mockResolvedValue([OWNED]);
    prismaMock.collection.create.mockResolvedValue(MAIN);
    prismaMock.userCollection.findMany.mockResolvedValueOnce([]);
    prismaMock.userCollection.create.mockResolvedValueOnce({ id: "uc_1" });

    await collectionAddPOST(addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1 }]));

    expect(prismaMock.collection.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.userCollection.create.mock.calls[0][0].data.collectionId).toBe("col_main");
  });

  // Server-cache families behind the client's TanStack invalidation.
  it("a successful add invalidates the collection/dashboard/collections cache families", async () => {
    prismaMock.userCollection.findMany.mockResolvedValueOnce([]);
    prismaMock.userCollection.create.mockResolvedValueOnce({ id: "uc_1" });

    const res = await collectionAddPOST(
      addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1 }])
    );
    expect((await res.json()).added).toBe(1);

    expect(invalidateUserCaches).toHaveBeenCalledTimes(1);
    expect(invalidateUserCaches).toHaveBeenCalledWith(
      USER_ID,
      expect.arrayContaining(["collection", "dashboard", "collections"])
    );
  });

  it("an add that files NOTHING does not invalidate any cache family", async () => {
    prismaMock.card.findFirst.mockResolvedValueOnce(null);
    prismaMock.card.create.mockRejectedValueOnce(new Error("boom"));

    const res = await collectionAddPOST(
      addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1 }])
    );
    expect(res.status).toBe(500);
    expect(invalidateUserCaches).not.toHaveBeenCalled();
  });
});
