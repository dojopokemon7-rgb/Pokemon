import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST .../[id]/sell — sale-integrity remediation (security phase 1) + BUG 4.
 *
 * Covers the guarded-atomic-decrement sale path:
 *   - partial sale splits correctly (guarded decrement + sold row, full provenance, GROSS)
 *   - full sale (guarded in-place flip, no active remainder, no extra row)
 *   - invalid quantity (<=0 / non-int) → 400, no write
 *   - sale quantity EXCEEDS available → 400 fast-fail, no write
 *   - concurrent sale (guard miss: updateMany count 0) → 409, no sold row
 *   - transaction rollback (sold-row create throws) → 500, decrement rolled back
 *   - duplicate request/retry → second call misses the guard → 409, no 2nd row
 *   - BUG 4: non-finite grossPricePerCopy → 400
 *
 * Prisma ($transaction/updateMany/create), the auth guard, the cache, and Redis
 * are MOCKED (no live DB/network), same harness as the sibling collection tests.
 */

const prismaMock = vi.hoisted(() => ({
  userCollection: {
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
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

// Redis idempotency guard. SET ... NX returns "OK" when the key is claimed and
// null when it already exists (a duplicate). Default: always claimable.
const redisMock = vi.hoisted(() => ({
  set: vi.fn(async (): Promise<string | null> => "OK"),
}));
vi.mock("@/lib/redis", () => ({ redis: redisMock }));

import { POST as sellPOST } from "@/app/api/users/me/collection/[id]/sell/route";

const LOT_ID = "uc_sold_1";

function sellBody(raw: string) {
  return new Request(`http://localhost/api/users/me/collection/${LOT_ID}/sell`, {
    method: "POST",
    body: raw,
  });
}
const sellParams = { params: Promise.resolve({ id: LOT_ID }) };

function lot(over: Record<string, unknown> = {}) {
  return {
    id: LOT_ID,
    userId: USER_ID,
    cardId: "card_1",
    quantity: 3,
    isFoil: false,
    condition: null,
    notes: null,
    purchasePrice: 5,
    costBasisSource: "user",
    costBasisCurrency: "USD",
    costBasisAttemptedAt: null,
    collectionId: "col_main",
    isSold: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.userCollection.findFirst.mockResolvedValue(lot());
  prismaMock.userCollection.update.mockResolvedValue({ id: LOT_ID });
  prismaMock.userCollection.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.userCollection.create.mockResolvedValue({ id: "uc_new" });
  redisMock.set.mockResolvedValue("OK");
  // Interactive $transaction(fn) → run the callback against the prisma mock;
  // array form → Promise.all. The sell route uses the interactive form.
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
      expect(prismaMock.userCollection.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.userCollection.create).not.toHaveBeenCalled();
    }
  );

  it("accepts a valid finite nonnegative price", async () => {
    const res = await sellPOST(sellBody(`{"quantity":1,"grossPricePerCopy":25}`), sellParams);
    expect(res.status).toBe(200);
  });
});

describe("partial sale — guarded decrement + split", () => {
  it("decrements the active lot via a guarded updateMany and creates a sold row with full provenance + GROSS proceeds", async () => {
    const res = await sellPOST(
      sellBody(`{"quantity":2,"grossPricePerCopy":10,"soldAt":"2024-03-01"}`),
      sellParams
    );
    expect(res.status).toBe(200);

    // Guarded decrement: only matches while still active AND quantity >= soldQty.
    expect(prismaMock.userCollection.updateMany).toHaveBeenCalledWith({
      where: { id: LOT_ID, userId: USER_ID, isSold: false, quantity: { gte: 2 } },
      data: { quantity: { decrement: 2 } },
    });

    // Sold row carries ALL provenance + GROSS proceeds (10 * 2 = 20).
    expect(prismaMock.userCollection.create).toHaveBeenCalledTimes(1);
    const soldData = prismaMock.userCollection.create.mock.calls[0][0].data;
    expect(soldData).toMatchObject({
      userId: USER_ID,
      cardId: "card_1",
      quantity: 2,
      isFoil: false,
      condition: null,
      purchasePrice: 5,
      costBasisSource: "user",
      costBasisCurrency: "USD",
      costBasisAttemptedAt: null,
      collectionId: "col_main",
      isSold: true,
      soldPrice: 20,
      soldCurrency: "USD",
    });
    expect(soldData.soldAt).toBeInstanceOf(Date);

    // Decrement + create happen inside ONE $transaction.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe("full sale — guarded in-place flip", () => {
  it("flips the row to sold via a guarded updateMany (exact quantity) and creates no extra row", async () => {
    const res = await sellPOST(sellBody(`{"quantity":3,"grossPricePerCopy":10}`), sellParams);
    expect(res.status).toBe(200);

    expect(prismaMock.userCollection.updateMany).toHaveBeenCalledWith({
      where: { id: LOT_ID, userId: USER_ID, isSold: false, quantity: 3 },
      data: expect.objectContaining({
        isSold: true,
        soldPrice: 30, // GROSS 10 * 3
        soldCurrency: "USD",
      }),
    });
    expect(prismaMock.userCollection.create).not.toHaveBeenCalled();
  });
});

describe("invalid quantity → 400, no write", () => {
  it.each(["0", "-1", "1.5"])("rejects quantity %s", async (q) => {
    const res = await sellPOST(sellBody(`{"quantity":${q},"grossPricePerCopy":10}`), sellParams);
    expect(res.status).toBe(400);
    expect(prismaMock.userCollection.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.userCollection.create).not.toHaveBeenCalled();
  });
});

describe("quantity exceeds available → 400 fast-fail, no write", () => {
  it("rejects selling more than the snapshot owns", async () => {
    const res = await sellPOST(sellBody(`{"quantity":5,"grossPricePerCopy":10}`), sellParams);
    expect(res.status).toBe(400);
    expect(prismaMock.userCollection.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.userCollection.create).not.toHaveBeenCalled();
  });
});

describe("concurrent sale (guard miss) → 409, no oversell", () => {
  it("partial: updateMany matches 0 rows (a racing sale consumed stock) → 409, no sold row", async () => {
    prismaMock.userCollection.updateMany.mockResolvedValue({ count: 0 });
    const res = await sellPOST(sellBody(`{"quantity":2,"grossPricePerCopy":10}`), sellParams);
    expect(res.status).toBe(409);
    expect(prismaMock.userCollection.create).not.toHaveBeenCalled();
  });

  it("full: updateMany matches 0 rows (lot changed under us) → 409", async () => {
    prismaMock.userCollection.updateMany.mockResolvedValue({ count: 0 });
    const res = await sellPOST(sellBody(`{"quantity":3,"grossPricePerCopy":10}`), sellParams);
    expect(res.status).toBe(409);
    expect(prismaMock.userCollection.create).not.toHaveBeenCalled();
  });
});

describe("transaction rollback — sold-row create throws", () => {
  it("surfaces 500 without a sold row when the create inside the tx fails (decrement rolls back with it)", async () => {
    prismaMock.userCollection.create.mockRejectedValue(new Error("db down"));
    const res = await sellPOST(sellBody(`{"quantity":2,"grossPricePerCopy":10}`), sellParams);
    expect(res.status).toBe(500);
    // Decrement and create were issued in the SAME $transaction call, so the
    // create failure rolls the decrement back (no partial write).
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe("duplicate request / retry — no double sold row", () => {
  it("a retry of a successful FULL sale misses the guard (quantity already gone) → 409, no 2nd flip", async () => {
    // First sale succeeds.
    const r1 = await sellPOST(sellBody(`{"quantity":3,"grossPricePerCopy":10}`), sellParams);
    expect(r1.status).toBe(200);

    // Retry: the lot is now sold/zero, so the guarded updateMany matches 0 rows.
    prismaMock.userCollection.findFirst.mockResolvedValue(lot({ quantity: 3 })); // stale snapshot still readable
    prismaMock.userCollection.updateMany.mockResolvedValue({ count: 0 });
    const r2 = await sellPOST(sellBody(`{"quantity":3,"grossPricePerCopy":10}`), sellParams);
    expect(r2.status).toBe(409);
    expect(prismaMock.userCollection.create).not.toHaveBeenCalled();
  });

  it("the short-window idempotency guard rejects an immediate identical resubmit with 429", async () => {
    // Redis reports the key already claimed → duplicate in-flight/just-done.
    redisMock.set.mockResolvedValue(null);
    const res = await sellPOST(sellBody(`{"quantity":2,"grossPricePerCopy":10}`), sellParams);
    expect(res.status).toBe(429);
    expect(prismaMock.userCollection.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.userCollection.create).not.toHaveBeenCalled();
  });

  it("a Redis outage (set throws) does NOT block the sale (fail-open, RULE 1)", async () => {
    redisMock.set.mockRejectedValue(new Error("redis down"));
    const res = await sellPOST(sellBody(`{"quantity":2,"grossPricePerCopy":10}`), sellParams);
    expect(res.status).toBe(200);
  });
});
