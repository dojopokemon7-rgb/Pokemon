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
  },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

// The service under test (does not exist yet → red).
import {
  createCollection,
  renameCollection,
  deleteCollection,
  updateCollectionSettings,
} from "@/lib/services/collection.service";
// The validator under test (does not exist yet → red).
import { CollectionTypeEnum } from "@/lib/validators/collection.validator";

const USER_ID = "user_123";

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
