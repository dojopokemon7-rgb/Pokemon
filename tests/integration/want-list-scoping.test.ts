import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * F-#8 — per-collection want-list scoping (service layer). RED phase.
 *
 * Pins the new `want-list.service` contract against a MOCKED Prisma client:
 *   - addWantListItem is an idempotent find-or-create at BOTH the null
 *     (account-level) and non-null (collection) scopes.
 *   - listWantList takes an options object and filters by collectionId
 *     (null = account, omission = all scopes, non-null = that collection).
 *   - moveWantListItem takes { intent, collectionId? } and is ownership-scoped.
 */

const prismaMock = vi.hoisted(() => ({
  wantListItem: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  card: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import {
  addWantListItem,
  listWantList,
  moveWantListItem,
} from "@/lib/services/want-list.service";

const USER_ID = "user_123";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.card.findMany.mockResolvedValue([]);
});

describe("addWantListItem — idempotent find-or-create", () => {
  it("at the account scope (collectionId omitted → null): findFirst matches by IS NULL, no second create", async () => {
    prismaMock.wantListItem.findFirst.mockResolvedValue({
      id: "w1",
      userId: USER_ID,
      cardId: "base1-4",
      intent: "BUY",
      collectionId: null,
    });

    const res = await addWantListItem(USER_ID, { cardId: "base1-4", intent: "BUY" });

    expect(prismaMock.wantListItem.findFirst).toHaveBeenCalledWith({
      where: { userId: USER_ID, cardId: "base1-4", intent: "BUY", collectionId: null },
    });
    expect(prismaMock.wantListItem.create).not.toHaveBeenCalled();
    expect(res.id).toBe("w1");
  });

  it("at a collection scope: creates when none exists", async () => {
    prismaMock.wantListItem.findFirst.mockResolvedValue(null);
    prismaMock.wantListItem.create.mockResolvedValue({
      id: "w2",
      userId: USER_ID,
      cardId: "base1-4",
      intent: "SELL",
      collectionId: "col_1",
    });

    const res = await addWantListItem(USER_ID, {
      cardId: "base1-4",
      intent: "SELL",
      collectionId: "col_1",
    });

    expect(prismaMock.wantListItem.findFirst).toHaveBeenCalledWith({
      where: { userId: USER_ID, cardId: "base1-4", intent: "SELL", collectionId: "col_1" },
    });
    expect(prismaMock.wantListItem.create).toHaveBeenCalledWith({
      data: { userId: USER_ID, cardId: "base1-4", intent: "SELL", collectionId: "col_1" },
    });
    expect(res.id).toBe("w2");
  });
});

describe("listWantList — options-object signature with collectionId filter", () => {
  beforeEach(() => {
    prismaMock.wantListItem.findMany.mockResolvedValue([]);
  });

  it("omitting collectionId returns all scopes (no collectionId key in where)", async () => {
    await listWantList(USER_ID, { intent: "BUY" });
    expect(prismaMock.wantListItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID, intent: "BUY" } })
    );
  });

  it("collectionId:null selects account-level rows", async () => {
    await listWantList(USER_ID, { collectionId: null });
    expect(prismaMock.wantListItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID, collectionId: null } })
    );
  });

  it("a non-null collectionId selects that collection", async () => {
    await listWantList(USER_ID, { intent: "SELL", collectionId: "col_9" });
    expect(prismaMock.wantListItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID, intent: "SELL", collectionId: "col_9" },
      })
    );
  });
});

describe("moveWantListItem — { intent, collectionId? } object signature, ownership-scoped", () => {
  it("updates intent only when collectionId is omitted (back-compat)", async () => {
    prismaMock.wantListItem.update.mockResolvedValue({ id: "w1", intent: "SELL" });
    await moveWantListItem(USER_ID, "w1", { intent: "SELL" });
    expect(prismaMock.wantListItem.update).toHaveBeenCalledWith({
      where: { id: "w1", userId: USER_ID },
      data: { intent: "SELL" },
    });
  });

  it("updates both intent and collectionId when supplied", async () => {
    prismaMock.wantListItem.update.mockResolvedValue({ id: "w1", intent: "BUY", collectionId: "col_2" });
    await moveWantListItem(USER_ID, "w1", { intent: "BUY", collectionId: "col_2" });
    expect(prismaMock.wantListItem.update).toHaveBeenCalledWith({
      where: { id: "w1", userId: USER_ID },
      data: { intent: "BUY", collectionId: "col_2" },
    });
  });

  it("a foreign id surfaces the Prisma P2025 (→ 404 at the route)", async () => {
    const { Prisma } = await import("@prisma/client");
    prismaMock.wantListItem.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("not found", { code: "P2025", clientVersion: "6" })
    );
    await expect(moveWantListItem(USER_ID, "nope", { intent: "BUY" })).rejects.toMatchObject({
      code: "P2025",
    });
  });
});
