import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * F-10 — Multiple Collections (backend/data layer). RED phase.
 *
 * Supabase (PostgreSQL) + Prisma — no Firebase. These tests pin the
 * service-layer contract for CRUD + privacy/tag validation against a
 * MOCKED Prisma client, so they define behavior without touching the
 * live remote DB or requiring a migration to run first.
 *
 * EXPECTED TO FAIL today: neither `@/lib/services/collection.service`
 * nor the `Collection` Zod validator exists yet, and the `Collection`
 * model isn't in the Prisma schema.
 */

// --- Mock the Prisma singleton used by the service ------------------
// `vi.mock` is hoisted above imports, so the mock object must be created
// via `vi.hoisted` to be available inside the (also-hoisted) factory.
const prismaMock = vi.hoisted(() => ({
  collection: {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  userCollection: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    groupBy: vi.fn(),
  },
  wantListItem: { groupBy: vi.fn() },
  cardSet: { upsert: vi.fn() },
  card: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  pricingHistory: { createMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const USER_ID = "user_123";
vi.mock("@/lib/utils/auth-guard", () => ({
  requireAuth: vi.fn(async () => ({ unauthorized: null, session: { user: { id: USER_ID } } })),
}));

// The service under test (does not exist yet → red).
import {
  createCollection,
  renameCollection,
  deleteCollection,
  updateCollectionSettings,
  listCollectionsWithBuckets,
} from "@/lib/services/collection.service";
// The validator under test (does not exist yet → red).
import { CollectionTypeEnum } from "@/lib/validators/collection.validator";
import { Prisma } from "@prisma/client";
import { PATCH as collectionItemPATCH } from "@/app/api/users/me/collection/[id]/route";
import { POST as collectionAddPOST } from "@/app/api/users/me/collection/route";

const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createCollection", () => {
  it("creates a collection with name, privacy, and type tag", async () => {
    prismaMock.collection.create.mockResolvedValue({
      id: "col_1",
      userId: USER_ID,
      name: "Vintage WOTC",
      isPrivate: true,
      typeTag: "POKEMON",
    });

    const result = await createCollection(USER_ID, {
      name: "Vintage WOTC",
      isPrivate: true,
      typeTag: "POKEMON",
    });

    expect(prismaMock.collection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: USER_ID,
          name: "Vintage WOTC",
          isPrivate: true,
          typeTag: "POKEMON",
        }),
      })
    );
    expect(result.id).toBe("col_1");
    expect(result.typeTag).toBe("POKEMON");
  });

  it("defaults isPrivate to true and typeTag to MIXED when omitted", async () => {
    prismaMock.collection.create.mockResolvedValue({
      id: "col_2",
      userId: USER_ID,
      name: "Misc",
      isPrivate: true,
      typeTag: "MIXED",
    });

    await createCollection(USER_ID, { name: "Misc" });

    expect(prismaMock.collection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isPrivate: true, typeTag: "MIXED" }),
      })
    );
  });

  it("rejects an empty name", async () => {
    await expect(createCollection(USER_ID, { name: "" })).rejects.toThrow();
    expect(prismaMock.collection.create).not.toHaveBeenCalled();
  });
});

describe("renameCollection", () => {
  it("renames a collection the user owns", async () => {
    prismaMock.collection.update.mockResolvedValue({
      id: "col_1",
      userId: USER_ID,
      name: "WOTC Holos",
      isPrivate: true,
      typeTag: "POKEMON",
    });

    const result = await renameCollection(USER_ID, "col_1", "WOTC Holos");

    expect(prismaMock.collection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "col_1" }),
        data: expect.objectContaining({ name: "WOTC Holos" }),
      })
    );
    expect(result.name).toBe("WOTC Holos");
  });

  it("rejects an empty new name", async () => {
    await expect(renameCollection(USER_ID, "col_1", "  ")).rejects.toThrow();
    expect(prismaMock.collection.update).not.toHaveBeenCalled();
  });
});

describe("deleteCollection", () => {
  it("deletes a collection the user owns", async () => {
    prismaMock.collection.delete.mockResolvedValue({ id: "col_1" });

    await deleteCollection(USER_ID, "col_1");

    expect(prismaMock.collection.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "col_1" }) })
    );
  });
});

describe("updateCollectionSettings (privacy & tags)", () => {
  it("toggles isPrivate and changes the typeTag", async () => {
    prismaMock.collection.update.mockResolvedValue({
      id: "col_1",
      userId: USER_ID,
      name: "Mixed Bag",
      isPrivate: false,
      typeTag: "MIXED",
    });

    const result = await updateCollectionSettings(USER_ID, "col_1", {
      isPrivate: false,
      typeTag: "MIXED",
    });

    expect(prismaMock.collection.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isPrivate: false, typeTag: "MIXED" }),
      })
    );
    expect(result.isPrivate).toBe(false);
  });

  it("rejects an invalid typeTag", async () => {
    await expect(
      // @ts-expect-error — deliberately invalid tag to prove validation
      updateCollectionSettings(USER_ID, "col_1", { typeTag: "DIGIMON" })
    ).rejects.toThrow();
    expect(prismaMock.collection.update).not.toHaveBeenCalled();
  });
});

describe("CollectionTypeEnum", () => {
  it("accepts the three valid tags and rejects others", () => {
    expect(CollectionTypeEnum.safeParse("POKEMON").success).toBe(true);
    expect(CollectionTypeEnum.safeParse("ONE_PIECE").success).toBe(true);
    expect(CollectionTypeEnum.safeParse("MIXED").success).toBe(true);
    expect(CollectionTypeEnum.safeParse("DIGIMON").success).toBe(false);
  });
});

// =============================================================
// F-#8 — per-collection 5-bucket model (design §6a, §6d, §6f)
// =============================================================

describe("listCollectionsWithBuckets — per-collection bucket counts", () => {
  it("assembles main/all/sold (Σ quantity) and buy/sell (row count) per collection + __uncat__", async () => {
    prismaMock.collection.findMany.mockResolvedValue([
      { id: "col_1", userId: USER_ID, name: "Vintage", isPrivate: true, typeTag: "POKEMON" },
    ]);
    prismaMock.userCollection.groupBy.mockResolvedValue([
      { collectionId: "col_1", isSold: false, _sum: { quantity: 120 } },
      { collectionId: "col_1", isSold: true, _sum: { quantity: 8 } },
      { collectionId: null, isSold: false, _sum: { quantity: 5 } },
    ]);
    prismaMock.wantListItem.groupBy.mockResolvedValue([
      { collectionId: "col_1", intent: "BUY", _count: { _all: 3 } },
      { collectionId: "col_1", intent: "SELL", _count: { _all: 1 } },
      { collectionId: null, intent: "BUY", _count: { _all: 2 } },
    ]);

    const data = await listCollectionsWithBuckets(USER_ID);
    const col1 = data.find((c) => c.id === "col_1")!;
    expect(col1.buckets).toEqual({ main: 120, all: 120, buy: 3, sell: 1, sold: 8 });

    const uncat = data.find((c) => c.id === "__uncat__")!;
    expect(uncat.buckets).toEqual({ main: 5, all: 5, buy: 2, sell: 0, sold: 0 });
  });

  it("degrades to ZEROED buckets (never omitted) when a groupBy throws", async () => {
    prismaMock.collection.findMany.mockResolvedValue([
      { id: "col_1", userId: USER_ID, name: "Vintage", isPrivate: true, typeTag: "POKEMON" },
    ]);
    prismaMock.userCollection.groupBy.mockRejectedValue(new Error("db down"));
    prismaMock.wantListItem.groupBy.mockRejectedValue(new Error("db down"));

    const data = await listCollectionsWithBuckets(USER_ID);
    const col1 = data.find((c) => c.id === "col_1")!;
    expect(col1.buckets).toEqual({ main: 0, all: 0, buy: 0, sell: 0, sold: 0 });
  });
});

describe("POST /api/users/me/collection — exact-condition dedupe + P2002 race", () => {
  function addBody(cards: unknown[]) {
    return new Request("http://localhost/api/users/me/collection", {
      method: "POST",
      body: JSON.stringify({ cards }),
    });
  }
  const CARD = { id: "card_1", externalId: "base1-4", marketPrice: 10 };

  beforeEach(() => {
    prismaMock.cardSet.upsert.mockResolvedValue({ id: "set_1" });
    prismaMock.card.findFirst.mockResolvedValue(CARD);
    prismaMock.card.update.mockResolvedValue(CARD);
    prismaMock.pricingHistory.createMany.mockResolvedValue({});
  });

  it("adding raw null then raw 'NM' of the same card yields TWO rows (exact-condition identity)", async () => {
    // First: raw null → no existing → create.
    prismaMock.userCollection.findMany.mockResolvedValueOnce([]);
    prismaMock.userCollection.create.mockResolvedValueOnce({ id: "uc_null" });
    await collectionAddPOST(addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1 }]));

    // Second: raw "NM" with an existing raw null lot present → exact-condition
    // compare must NOT match the null lot, so it creates a SECOND row.
    prismaMock.userCollection.findMany.mockResolvedValueOnce([
      { id: "uc_null", condition: null, quantity: 1 },
    ]);
    prismaMock.userCollection.create.mockResolvedValueOnce({ id: "uc_nm" });
    await collectionAddPOST(
      addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1, condition: "NM" }])
    );

    expect(prismaMock.userCollection.create).toHaveBeenCalledTimes(2);
    expect(prismaMock.userCollection.update).not.toHaveBeenCalled();
  });

  it("adding the same raw null twice increments ONE row", async () => {
    prismaMock.userCollection.findMany.mockResolvedValueOnce([
      { id: "uc_null", condition: null, quantity: 2 },
    ]);
    prismaMock.userCollection.update.mockResolvedValueOnce({ id: "uc_null", quantity: 3 });
    await collectionAddPOST(addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1 }]));
    expect(prismaMock.userCollection.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.userCollection.create).not.toHaveBeenCalled();
  });

  it("raw vs 'PSA 10' stays TWO rows", async () => {
    prismaMock.userCollection.findMany.mockResolvedValueOnce([
      { id: "uc_raw", condition: null, quantity: 1 },
    ]);
    prismaMock.userCollection.create.mockResolvedValueOnce({ id: "uc_psa" });
    await collectionAddPOST(
      addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1, condition: "PSA 10" }])
    );
    expect(prismaMock.userCollection.create).toHaveBeenCalledTimes(1);
  });

  it("a concurrent P2002 on create re-reads and increments the raced lot (ok:true, not 500)", async () => {
    prismaMock.userCollection.findMany.mockResolvedValueOnce([]); // app-side miss
    prismaMock.userCollection.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "6",
        meta: { target: ["uc_variant_coalesced"] },
      })
    );
    // Re-read finds the raced lot.
    prismaMock.userCollection.findFirst.mockResolvedValueOnce({
      id: "uc_raced",
      condition: null,
      quantity: 1,
    });
    prismaMock.userCollection.update.mockResolvedValueOnce({ id: "uc_raced", quantity: 2 });

    const res = await collectionAddPOST(
      addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1 }])
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.added).toBe(1);
    expect(json.results[0].ok).toBe(true);
    expect(prismaMock.userCollection.update).toHaveBeenCalledTimes(1);
  });
});

describe("PATCH /api/users/me/collection/[id] — re-file 409 + cross-user 404 (§6f)", () => {
  it("returns 409 when the re-file collides on uc_variant_coalesced (not a raw 500)", async () => {
    prismaMock.userCollection.findFirst.mockResolvedValue({
      id: "uc_1",
      userId: USER_ID,
      isSold: false,
      card: { marketPrice: 10 },
      collectionId: "col_a",
    });
    prismaMock.collection.findFirst.mockResolvedValue({ id: "col_b", userId: USER_ID });
    prismaMock.userCollection.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "6",
        meta: { target: ["uc_variant_coalesced"] },
      })
    );

    const req = new Request("http://localhost/x", {
      method: "PATCH",
      body: JSON.stringify({ collectionId: "col_b" }),
    });
    const res = await collectionItemPATCH(req, ctxFor("uc_1"));
    expect(res.status).toBe(409);
    expect((await res.json()).message).toMatch(/already in the target collection/i);
  });

  it("returns 404 when the target collectionId belongs to another user", async () => {
    prismaMock.userCollection.findFirst.mockResolvedValue({
      id: "uc_1",
      userId: USER_ID,
      isSold: false,
      card: { marketPrice: 10 },
      collectionId: null,
    });
    prismaMock.collection.findFirst.mockResolvedValue(null); // foreign/non-owned

    const req = new Request("http://localhost/x", {
      method: "PATCH",
      body: JSON.stringify({ collectionId: "foreign_col" }),
    });
    const res = await collectionItemPATCH(req, ctxFor("uc_1"));
    expect(res.status).toBe(404);
  });
});
