import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * BUG 4 (audit 13 F-09) — POST .../[id]/sell must reject a non-finite gross
 * price (Infinity/NaN) with 400. grossPricePerCopy now carries .finite()
 * (RULE 4) — z.number() alone accepts Infinity.
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

import { POST as sellPOST } from "@/app/api/users/me/collection/[id]/sell/route";

const LOT_ID = "uc_sold_1";

function sellBody(raw: string) {
  return new Request(`http://localhost/api/users/me/collection/${LOT_ID}/sell`, {
    method: "POST",
    body: raw,
  });
}
const sellParams = { params: Promise.resolve({ id: LOT_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.userCollection.findFirst.mockResolvedValue({
    id: LOT_ID,
    userId: USER_ID,
    cardId: "card_1",
    quantity: 3,
    isFoil: false,
    condition: null,
    collectionId: "col_main",
    isSold: false,
    costBasisCurrency: "USD",
  });
  prismaMock.userCollection.update.mockResolvedValue({ id: LOT_ID });
  prismaMock.userCollection.create.mockResolvedValue({ id: "uc_new" });
  // A partial sale (qty < lot.quantity) runs $transaction([update, create]);
  // pass the array of promises through so the route can destructure the result.
  prismaMock.$transaction.mockImplementation(async (ops: unknown) =>
    Array.isArray(ops) ? Promise.all(ops) : (ops as (tx: unknown) => unknown)(prismaMock)
  );
});

describe("BUG 4 — sell gross price must be finite + nonnegative", () => {
  it.each(["Infinity", "NaN"])(
    "rejects a non-finite grossPricePerCopy (%s) with 400, no write",
    async (literal) => {
      const res = await sellPOST(
        sellBody(`{"quantity":1,"grossPricePerCopy":${literal}}`),
        sellParams
      );
      expect(res.status).toBe(400);
      expect(prismaMock.userCollection.update).not.toHaveBeenCalled();
    }
  );

  it("accepts a valid finite nonnegative price", async () => {
    const res = await sellPOST(sellBody(`{"quantity":1,"grossPricePerCopy":25}`), sellParams);
    expect(res.status).toBe(200);
  });
});
