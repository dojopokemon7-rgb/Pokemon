import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * DEV-9 — strict price/date validation at the collection add/update boundaries
 * (RULE 4: Zod at every boundary). purchasePrice / soldPrice must reject
 * negative, NaN, and Infinity; soldAt must reject a malformed date. Valid
 * nonnegative finite values and parseable dates still pass. Prisma, the auth
 * guard, and the cache are MOCKED — same pattern as
 * collection-add-price-fabrication.test.ts (no live DB/network).
 */

const prismaMock = vi.hoisted(() => ({
  collection: { findMany: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
  userCollection: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
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

vi.mock("@/lib/utils/cache", () => ({
  cacheGetJson: vi.fn(async () => null),
  cacheSetJson: vi.fn(async () => undefined),
  invalidateUserCaches: vi.fn(async () => undefined),
}));

import { POST as collectionAddPOST } from "@/app/api/users/me/collection/route";
import { PATCH as collectionItemPATCH } from "@/app/api/users/me/collection/[id]/route";

const EXISTING_CARD = { id: "card_1", externalId: "base1-4", marketPrice: 10 };
const MAIN = { id: "col_main", name: "Main" };
const ITEM_ID = "uc_1";
const EXISTING_ITEM = {
  id: ITEM_ID,
  userId: USER_ID,
  cardId: "card_1",
  quantity: 1,
  isFoil: false,
  condition: null,
  notes: null,
  purchasePrice: 5,
  collectionId: MAIN.id,
  isSold: false,
  card: EXISTING_CARD,
};

function addBody(cards: unknown[]) {
  return new Request("http://localhost/api/users/me/collection", {
    method: "POST",
    body: JSON.stringify({ cards }),
  });
}

/** Raw (non-JSON-safe) body — NaN/Infinity are not valid JSON literals, so a
 *  payload carrying them is rejected at the JSON boundary before Zod. This is
 *  how a non-finite price actually "arrives": it can't. */
function rawAddBody(raw: string) {
  return new Request("http://localhost/api/users/me/collection", {
    method: "POST",
    body: raw,
  });
}

function patchBody(patch: Record<string, unknown>) {
  return new Request(`http://localhost/api/users/me/collection/${ITEM_ID}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}
function rawPatchBody(raw: string) {
  return new Request(`http://localhost/api/users/me/collection/${ITEM_ID}`, {
    method: "PATCH",
    body: raw,
  });
}
const patchParams = { params: Promise.resolve({ id: ITEM_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.collection.findMany.mockResolvedValue([MAIN]);
  prismaMock.cardSet.upsert.mockResolvedValue({ id: "set_1" });
  prismaMock.card.findFirst.mockResolvedValue(EXISTING_CARD);
  prismaMock.pricingHistory.createMany.mockResolvedValue({});
  prismaMock.userCollection.findMany.mockResolvedValue([]);
  prismaMock.userCollection.create.mockResolvedValue({ id: ITEM_ID });
  prismaMock.userCollection.findFirst.mockResolvedValue(EXISTING_ITEM);
  prismaMock.userCollection.update.mockResolvedValue({ ...EXISTING_ITEM });
});

describe("POST add — purchasePrice must be finite + nonnegative", () => {
  it("rejects a negative purchasePrice (-5) with 400, no write", async () => {
    const res = await collectionAddPOST(
      addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1, purchasePrice: -5 }])
    );
    expect(res.status).toBe(400);
    expect(prismaMock.userCollection.create).not.toHaveBeenCalled();
  });

  it.each(["NaN", "Infinity"])(
    "rejects a non-finite purchasePrice literal (%s) at the JSON boundary with 400",
    async (literal) => {
      // NaN/Infinity are not legal JSON, so request.json() throws → 400 before
      // Zod. The .finite() guard is the second line of defence if a value ever
      // reaches the schema by another path.
      const res = await collectionAddPOST(
        rawAddBody(
          `{"cards":[{"externalId":"base1-4","name":"Alakazam","quantity":1,"purchasePrice":${literal}}]}`
        )
      );
      expect(res.status).toBe(400);
      expect(prismaMock.userCollection.create).not.toHaveBeenCalled();
    }
  );

  it("accepts a valid nonnegative finite purchasePrice", async () => {
    const res = await collectionAddPOST(
      addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1, purchasePrice: 42 }])
    );
    expect(res.status).toBe(200);
    expect((await res.json()).added).toBe(1);
  });
});

describe("PATCH update — soldPrice finite/nonnegative, soldAt a valid date", () => {
  it("rejects a negative soldPrice with 400", async () => {
    const res = await collectionItemPATCH(patchBody({ soldPrice: -1 }), patchParams);
    expect(res.status).toBe(400);
    expect(prismaMock.userCollection.update).not.toHaveBeenCalled();
  });

  it.each(["NaN", "Infinity"])(
    "rejects a non-finite soldPrice literal (%s) at the JSON boundary with 400",
    async (literal) => {
      const res = await collectionItemPATCH(
        rawPatchBody(`{"soldPrice":${literal}}`),
        patchParams
      );
      expect(res.status).toBe(400);
      expect(prismaMock.userCollection.update).not.toHaveBeenCalled();
    }
  );

  it("rejects a malformed soldAt with 400", async () => {
    const res = await collectionItemPATCH(patchBody({ soldAt: "not-a-date" }), patchParams);
    expect(res.status).toBe(400);
    expect(prismaMock.userCollection.update).not.toHaveBeenCalled();
  });

  it("accepts a valid soldPrice + soldAt", async () => {
    const res = await collectionItemPATCH(
      patchBody({ soldPrice: 25, soldAt: "2024-01-15" }),
      patchParams
    );
    expect(res.status).toBe(200);
    expect(prismaMock.userCollection.update).toHaveBeenCalled();
  });
});
