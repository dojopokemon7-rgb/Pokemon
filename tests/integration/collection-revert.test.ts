import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * BUG 2 (audit 13 F-01 / 03 P-21) — PATCH .../[id] revert ({isSold:false}) after
 * a PARTIAL sale must NOT 500 on the uc_variant_coalesced P2002. The reverted
 * quantity MERGES back into the active sibling lot (true undo), or flips the row
 * when no sibling exists; a concurrent P2002 maps to 409.
 *
 * Prisma, the auth guard, and the cache are MOCKED (no live DB/network), same
 * harness as collection-price-validation.test.ts.
 */

const prismaMock = vi.hoisted(() => ({
  userCollection: {
    findFirst: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
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

import { PATCH as itemPATCH } from "@/app/api/users/me/collection/[id]/route";

const LOT_ID = "uc_sold_1";
const ACTIVE_SIBLING_ID = "uc_active_1";

const soldLot = (over: Record<string, unknown> = {}) => ({
  id: LOT_ID,
  userId: USER_ID,
  cardId: "card_1",
  quantity: 2,
  isFoil: false,
  condition: null,
  collectionId: "col_main",
  isSold: true,
  soldPrice: 40,
  soldAt: new Date(),
  card: { id: "card_1", externalId: "base1-4", marketPrice: 10 },
  ...over,
});

function patchBody(patch: Record<string, unknown>) {
  return new Request(`http://localhost/api/users/me/collection/${LOT_ID}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}
const patchParams = { params: Promise.resolve({ id: LOT_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  // $transaction passes an array-of-promises through (what the route uses).
  prismaMock.$transaction.mockImplementation(async (ops: unknown) =>
    Array.isArray(ops) ? Promise.all(ops) : (ops as (tx: unknown) => unknown)(prismaMock)
  );
});

describe("BUG 2 — revert after a partial sale merges back, never 500/P2002", () => {
  it("MERGES the reverted qty into the active sibling and deletes the sold row (200)", async () => {
    prismaMock.userCollection.findFirst
      .mockResolvedValueOnce(soldLot()) // ownership lookup (the row being reverted)
      .mockResolvedValueOnce({
        id: ACTIVE_SIBLING_ID,
        userId: USER_ID,
        cardId: "card_1",
        quantity: 1,
        isFoil: false,
        condition: null,
        collectionId: "col_main",
        isSold: false,
      }); // active sibling

    const res = await itemPATCH(patchBody({ isSold: false }), patchParams);
    expect(res.status).toBe(200);
    // Merge-back: sibling incremented by the sold qty, sold row deleted, in a tx.
    expect(prismaMock.$transaction).toHaveBeenCalled();
    expect(prismaMock.userCollection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ACTIVE_SIBLING_ID },
        data: { quantity: 1 + 2 },
      })
    );
    expect(prismaMock.userCollection.delete).toHaveBeenCalledWith({ where: { id: LOT_ID } });
  });

  it("flips the row to active when NO active sibling exists (200)", async () => {
    prismaMock.userCollection.findFirst
      .mockResolvedValueOnce(soldLot()) // ownership lookup
      .mockResolvedValueOnce(null); // no sibling
    prismaMock.userCollection.update.mockResolvedValue({ id: LOT_ID, isSold: false });

    const res = await itemPATCH(patchBody({ isSold: false }), patchParams);
    expect(res.status).toBe(200);
    expect(prismaMock.userCollection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: LOT_ID },
        data: expect.objectContaining({ isSold: false }),
      })
    );
    expect(prismaMock.userCollection.delete).not.toHaveBeenCalled();
  });

  it("maps a concurrent P2002 on revert to 409, not 500", async () => {
    prismaMock.userCollection.findFirst
      .mockResolvedValueOnce(soldLot()) // ownership lookup
      .mockResolvedValueOnce(null); // no sibling at read time → plain flip path
    const { Prisma } = await import("@prisma/client");
    const err = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: "uc_variant_coalesced" },
    });
    prismaMock.userCollection.update.mockRejectedValue(err);

    const res = await itemPATCH(patchBody({ isSold: false }), patchParams);
    expect(res.status).toBe(409);
  });
});
