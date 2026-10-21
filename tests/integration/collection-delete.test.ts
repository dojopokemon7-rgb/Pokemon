import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * audit 05 F-01 / 01 P-05 (HIGH) — DELETE /api/collections/[id] must be SAFE &
 * ATOMIC. `UserCollection.collectionId` / `WantListItem.collectionId` are
 * `onDelete: SetNull`, so a bare collection delete NULLs the collection's active
 * lots / want rows. The partial unique indexes `uc_variant_coalesced`
 * (WHERE isSold=false) and `wli_scope_coalesced` treat NULL as '', so if the
 * user already holds a NULL-scoped sibling of the same variant/intent, SetNull
 * collides → Postgres P2002 → an uncaught 500 (the collection silently survives).
 *
 * The fix re-homes active lots to the uncategorized scope BEFORE deleting,
 * MERGING into any colliding NULL-scoped lot (quantity conserved), and drops
 * duplicate want rows — all in one `$transaction`. A concurrent P2002 maps to 409.
 *
 * Prisma, the auth guard, and the cache are MOCKED (no live DB/network), same
 * harness as collection-revert.test.ts.
 */

const prismaMock = vi.hoisted(() => ({
  collection: {
    findFirst: vi.fn(),
    delete: vi.fn(),
  },
  userCollection: {
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  wantListItem: {
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const USER_ID = "user_123";
vi.mock("@/lib/utils/auth-guard", () => ({
  requireAuth: vi.fn(async () => ({ unauthorized: null, session: { user: { id: USER_ID } } })),
}));

vi.mock("@/lib/utils/cache", () => ({
  invalidateUserCaches: vi.fn(async () => undefined),
}));

import { DELETE as collectionDELETE } from "@/app/api/collections/[id]/route";
import { Prisma } from "@prisma/client";

const COL_ID = "col_A";
const ctx = { params: Promise.resolve({ id: COL_ID }) };

function delReq() {
  return new Request(`http://localhost/api/collections/${COL_ID}`, { method: "DELETE" });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Interactive-callback $transaction: invoke the callback with the mock client.
  prismaMock.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb(prismaMock)
  );
  // assertNotMain reads { name } — a non-Main collection the user owns.
  prismaMock.collection.findFirst.mockResolvedValue({ name: "Vintage WOTC" });
  prismaMock.collection.delete.mockResolvedValue({ id: COL_ID });
  // Default: no want rows in the collection, none null-scoped.
  prismaMock.wantListItem.findMany.mockResolvedValue([]);
});

describe("DELETE /api/collections/[id] — safe & atomic (audit 05 F-01 / 01 P-05)", () => {
  it("MERGES a colliding active lot into the NULL-scoped sibling and deletes the collection (no 500)", async () => {
    const lot = {
      id: "uc_in_col",
      userId: USER_ID,
      cardId: "card_X",
      isFoil: false,
      condition: null,
      quantity: 2,
      isSold: false,
    };
    const sibling = {
      id: "uc_null",
      userId: USER_ID,
      cardId: "card_X",
      isFoil: false,
      condition: null,
      quantity: 3,
      isSold: false,
    };
    // 1st findMany → lots in the collection; 2nd → user's NULL-scoped active lots.
    prismaMock.userCollection.findMany
      .mockResolvedValueOnce([lot])
      .mockResolvedValueOnce([sibling]);

    const res = await collectionDELETE(delReq(), ctx);
    expect(res.status).toBe(200);
    // Sibling bumped by the lot's quantity, duplicate lot removed, inside a tx.
    expect(prismaMock.$transaction).toHaveBeenCalled();
    expect(prismaMock.userCollection.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "uc_null" }, data: { quantity: 3 + 2 } })
    );
    expect(prismaMock.userCollection.delete).toHaveBeenCalledWith({ where: { id: "uc_in_col" } });
    // The collection is actually deleted, ownership-scoped.
    expect(prismaMock.collection.delete).toHaveBeenCalledWith({
      where: { id: COL_ID, userId: USER_ID },
    });
  });

  it("happy path: no colliding lot → re-homes the lot to NULL scope (not deleted), returns { data: { id } }", async () => {
    const lot = {
      id: "uc_in_col",
      userId: USER_ID,
      cardId: "card_X",
      isFoil: false,
      condition: null,
      quantity: 1,
      isSold: false,
    };
    prismaMock.userCollection.findMany
      .mockResolvedValueOnce([lot])
      .mockResolvedValueOnce([]); // no NULL-scoped siblings

    const res = await collectionDELETE(delReq(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: COL_ID } });
    // Lot re-homed to NULL scope, NOT deleted.
    expect(prismaMock.userCollection.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "uc_in_col" }, data: { collectionId: null } })
    );
    expect(prismaMock.userCollection.delete).not.toHaveBeenCalled();
    expect(prismaMock.collection.delete).toHaveBeenCalled();
  });

  it("want-row collision: drops the duplicate account-scoped want row (no P2002)", async () => {
    prismaMock.userCollection.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const want = { id: "wli_in_col", userId: USER_ID, cardId: "card_X", intent: "BUY" };
    const nullWant = { id: "wli_null", userId: USER_ID, cardId: "card_X", intent: "BUY" };
    // 1st findMany → want rows in the collection; 2nd → null-scoped want rows.
    prismaMock.wantListItem.findMany
      .mockResolvedValueOnce([want])
      .mockResolvedValueOnce([nullWant]);

    const res = await collectionDELETE(delReq(), ctx);
    expect(res.status).toBe(200);
    expect(prismaMock.wantListItem.delete).toHaveBeenCalledWith({ where: { id: "wli_in_col" } });
    expect(prismaMock.wantListItem.update).not.toHaveBeenCalled();
    expect(prismaMock.collection.delete).toHaveBeenCalled();
  });

  it("maps a concurrent P2002 (race) to 409, not 500", async () => {
    prismaMock.userCollection.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prismaMock.collection.delete.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: "uc_variant_coalesced" },
      })
    );

    const res = await collectionDELETE(delReq(), ctx);
    expect(res.status).toBe(409);
  });

  it("preserves P2025 → 404 (foreign/nonexistent id)", async () => {
    prismaMock.userCollection.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prismaMock.collection.delete.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("missing", {
        code: "P2025",
        clientVersion: "test",
      })
    );

    const res = await collectionDELETE(delReq(), ctx);
    expect(res.status).toBe(404);
  });
});
