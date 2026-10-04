import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * FEAT-003 (Part 3, design §3.4) — server-side ownership coercion on the
 * add-to-collection POST. Prisma is MOCKED (no live DB/network).
 *
 * Contract pinned here:
 *   - AC-15: a collectionId the user does NOT own (absent from the mocked
 *     collection.findMany) is coerced to null — the copy is filed loose, with
 *     no 4xx and no id-enumeration leak.
 *   - AC-17: an OWNED collectionId is honored verbatim on the create/update.
 *   - fast path: a batch with no collectionId on any item never queries
 *     collection.findMany at all.
 */

const prismaMock = vi.hoisted(() => ({
  collection: { findMany: vi.fn() },
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

function addBody(cards: unknown[]) {
  return new Request("http://localhost/api/users/me/collection", {
    method: "POST",
    body: JSON.stringify({ cards }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.cardSet.upsert.mockResolvedValue({ id: "set_1" });
  prismaMock.card.findFirst.mockResolvedValue(CARD);
  prismaMock.card.update.mockResolvedValue(CARD);
  prismaMock.pricingHistory.createMany.mockResolvedValue({});
});

describe("POST /api/users/me/collection — ownership coercion", () => {
  it("coerces a foreign (non-owned) collectionId to null on create (AC-15)", async () => {
    // User owns only col_owned; the request targets col_foreign.
    prismaMock.collection.findMany.mockResolvedValueOnce([{ id: "col_owned" }]);
    prismaMock.userCollection.findMany.mockResolvedValueOnce([]); // no existing lot
    prismaMock.userCollection.create.mockResolvedValueOnce({ id: "uc_1" });

    const res = await collectionAddPOST(
      addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1, collectionId: "col_foreign" }])
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.added).toBe(1);
    // Filed loose, not under the foreign id.
    expect(prismaMock.userCollection.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.userCollection.create.mock.calls[0][0].data.collectionId).toBeNull();
    // The scoped find also used null, never the foreign id.
    expect(prismaMock.userCollection.findMany.mock.calls[0][0].where.collectionId).toBeNull();
  });

  it("files an OWNED collectionId under that id (AC-17)", async () => {
    prismaMock.collection.findMany.mockResolvedValueOnce([{ id: "col_owned" }]);
    prismaMock.userCollection.findMany.mockResolvedValueOnce([]);
    prismaMock.userCollection.create.mockResolvedValueOnce({ id: "uc_1" });

    const res = await collectionAddPOST(
      addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1, collectionId: "col_owned" }])
    );
    const json = await res.json();

    expect(json.added).toBe(1);
    expect(prismaMock.userCollection.create.mock.calls[0][0].data.collectionId).toBe("col_owned");
  });

  it("honors an OWNED collectionId on the increment (update) path (AC-17)", async () => {
    prismaMock.collection.findMany.mockResolvedValueOnce([{ id: "col_owned" }]);
    // Existing lot in that bucket → increments instead of creating.
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

  it("fast path: no item carries a collectionId → collection.findMany is NEVER called", async () => {
    prismaMock.userCollection.findMany.mockResolvedValueOnce([]);
    prismaMock.userCollection.create.mockResolvedValueOnce({ id: "uc_1" });

    await collectionAddPOST(addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1 }]));

    expect(prismaMock.collection.findMany).not.toHaveBeenCalled();
    // And the loose lot is filed with null.
    expect(prismaMock.userCollection.create.mock.calls[0][0].data.collectionId).toBeNull();
  });

  // The four TanStack query families the client invalidates on a successful add
  // (["collection"], ["portfolio-collection"], ["collections"], ["collection", id])
  // are driven server-side by the per-user cache invalidation this route fires.
  // Pin that a successful add invalidates the server-cache families that back
  // them — collection + dashboard + collections — so the chosen collection and
  // the dashboard chart both refetch (HIGH-1). A no-op add must NOT invalidate.
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
    // Card lookup/create throws → the single item fails → addedCount 0 → the
    // route must skip invalidation entirely (no needless refetch storm).
    prismaMock.card.findFirst.mockResolvedValueOnce(null);
    prismaMock.card.create.mockRejectedValueOnce(new Error("boom"));

    const res = await collectionAddPOST(
      addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1 }])
    );
    expect(res.status).toBe(500);
    expect(invalidateUserCaches).not.toHaveBeenCalled();
  });
});
