import { describe, it, expect, vi, beforeEach } from "vitest";

/** FEAT-004 — DELETE /api/users/me/collection/[id]: owner-scoped removal. Prisma MOCKED. */
const prismaMock = vi.hoisted(() => ({ userCollection: { deleteMany: vi.fn() } }));
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

import { DELETE } from "@/app/api/users/me/collection/[id]/route";
import { invalidateUserCaches } from "@/lib/utils/cache";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://localhost/x", { method: "DELETE" });

beforeEach(() => vi.resetAllMocks());

describe("DELETE /api/users/me/collection/[id]", () => {
  it("is owner-scoped (where {id,userId}) and invalidates collection, dashboard AND collections", async () => {
    prismaMock.userCollection.deleteMany.mockResolvedValue({ count: 1 });
    const res = await DELETE(req(), ctx("uc_1"));
    expect(res.status).toBe(200);
    expect(prismaMock.userCollection.deleteMany).toHaveBeenCalledWith({ where: { id: "uc_1", userId: USER_ID } });
    expect(invalidateUserCaches).toHaveBeenCalledWith(USER_ID, expect.arrayContaining(["collection", "dashboard", "collections"]));
  });

  it("a foreign id removes nothing → 404 and no cache invalidation", async () => {
    prismaMock.userCollection.deleteMany.mockResolvedValue({ count: 0 });
    const res = await DELETE(req(), ctx("someone_elses"));
    expect(res.status).toBe(404);
    expect(invalidateUserCaches).not.toHaveBeenCalled();
  });
});
