import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

/** FEAT-004 — protected per-user Main collection. Prisma is MOCKED. */
const prismaMock = vi.hoisted(() => ({
  collection: {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
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

import {
  getOrCreateMainCollection,
  createCollection,
  renameCollection,
  deleteCollection,
  updateCollectionSettings,
  MainCollectionProtectedError,
} from "@/lib/services/collection.service";
import { POST as collectionsPOST } from "@/app/api/collections/route";
import { PATCH as collectionPATCH, DELETE as collectionDELETE } from "@/app/api/collections/[id]/route";

const MAIN = { id: "col_main", userId: USER_ID, name: "Main", isPrivate: true, typeTag: "MIXED" };
const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.resetAllMocks();
});

describe("getOrCreateMainCollection", () => {
  it("returns an existing Main (case/space-insensitive) without creating", async () => {
    prismaMock.collection.findMany.mockResolvedValue([
      { ...MAIN, id: "other", name: "Vintage" },
      { ...MAIN, name: " MAIN " },
    ]);
    const main = await getOrCreateMainCollection(USER_ID);
    expect(main.id).toBe("col_main");
    expect(prismaMock.collection.create).not.toHaveBeenCalled();
    expect(prismaMock.collection.findMany.mock.calls[0][0].where).toEqual({ userId: USER_ID });
  });

  it("creates Main once when missing", async () => {
    prismaMock.collection.findMany.mockResolvedValue([]);
    prismaMock.collection.create.mockResolvedValue(MAIN);
    const main = await getOrCreateMainCollection(USER_ID);
    expect(main.id).toBe("col_main");
    expect(prismaMock.collection.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.collection.create.mock.calls[0][0].data).toMatchObject({
      userId: USER_ID,
      name: "Main",
    });
  });

  it("on a concurrent P2002 re-reads and returns the same row (idempotent)", async () => {
    prismaMock.collection.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([MAIN]);
    prismaMock.collection.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "6" })
    );
    const main = await getOrCreateMainCollection(USER_ID);
    expect(main.id).toBe("col_main");
    expect(prismaMock.collection.create).toHaveBeenCalledTimes(1);
  });
});

describe("Main protection", () => {
  beforeEach(() => {
    prismaMock.collection.findFirst.mockResolvedValue({ name: "Main" });
    prismaMock.collection.findMany.mockResolvedValue([MAIN]);
  });

  it("rejects rename / delete / settings change of Main with zero writes", async () => {
    await expect(renameCollection(USER_ID, "col_main", "Other")).rejects.toBeInstanceOf(MainCollectionProtectedError);
    await expect(deleteCollection(USER_ID, "col_main")).rejects.toBeInstanceOf(MainCollectionProtectedError);
    await expect(updateCollectionSettings(USER_ID, "col_main", { isPrivate: false })).rejects.toBeInstanceOf(
      MainCollectionProtectedError
    );
    expect(prismaMock.collection.update).not.toHaveBeenCalled();
    expect(prismaMock.collection.delete).not.toHaveBeenCalled();
  });

  it("the ownership lookup is scoped to the acting user", async () => {
    await expect(deleteCollection(USER_ID, "col_main")).rejects.toThrow();
    expect(prismaMock.collection.findFirst.mock.calls[0][0].where).toEqual({ id: "col_main", userId: USER_ID });
  });

  it("createCollection('main') when Main exists is a conflict", async () => {
    await expect(createCollection(USER_ID, { name: "main" })).rejects.toBeInstanceOf(MainCollectionProtectedError);
    expect(prismaMock.collection.create).not.toHaveBeenCalled();
  });

  it("non-Main collections still rename/delete normally", async () => {
    prismaMock.collection.findFirst.mockResolvedValue({ name: "Vintage" });
    prismaMock.collection.update.mockResolvedValue({ id: "c1", name: "New" });
    prismaMock.collection.delete.mockResolvedValue({ id: "c1" });
    await renameCollection(USER_ID, "c1", "New");
    await deleteCollection(USER_ID, "c1");
    expect(prismaMock.collection.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.collection.delete).toHaveBeenCalledTimes(1);
  });

  it("a foreign/nonexistent id falls through to the original P2025 path", async () => {
    prismaMock.collection.findFirst.mockResolvedValue(null);
    prismaMock.collection.delete.mockResolvedValue({});
    await deleteCollection(USER_ID, "foreign");
    expect(prismaMock.collection.delete.mock.calls[0][0].where).toEqual({ id: "foreign", userId: USER_ID });
  });
});

describe("routes map MainCollectionProtectedError to 409", () => {
  beforeEach(() => {
    prismaMock.collection.findFirst.mockResolvedValue({ name: "Main" });
    prismaMock.collection.findMany.mockResolvedValue([MAIN]);
  });

  it("POST /api/collections name 'main' -> 409", async () => {
    const res = await collectionsPOST(
      new Request("http://localhost/api/collections", { method: "POST", body: JSON.stringify({ name: "main" }) })
    );
    expect(res.status).toBe(409);
    expect((await res.json()).message).toMatch(/main/i);
  });

  it("PATCH and DELETE /api/collections/[id] on Main -> 409", async () => {
    const patch = await collectionPATCH(
      new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify({ name: "Zed" }) }),
      ctxFor("col_main")
    );
    expect(patch.status).toBe(409);
    const del = await collectionDELETE(new Request("http://localhost/x", { method: "DELETE" }), ctxFor("col_main"));
    expect(del.status).toBe(409);
  });
});
