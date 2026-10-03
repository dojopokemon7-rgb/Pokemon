import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Cache invalidation on mutation (fail-open Redis caching).
 *
 * Proves that a WRITE route deletes exactly the per-user keys its data feeds,
 * best-effort, after the DB write. Mocks Prisma + the ioredis singleton (no
 * live DB/network — the real RedisKeys registry is kept so we assert against
 * production keys).
 *
 *   - collection create (POST /api/collections) → collections:{userId} +
 *     dashboard:{userId}
 *   - want-list add (POST /api/want-list)        → wantlist:{userId}:* family
 *     + dashboard:{userId}
 */

const USER_ID = "user_123";

vi.mock("@/lib/utils/auth-guard", () => ({
  requireAuth: vi.fn(async () => ({
    unauthorized: null,
    session: { user: { id: USER_ID } },
  })),
}));

// Prisma singleton — only the methods these two write paths touch.
const prismaMock = vi.hoisted(() => ({
  collection: { create: vi.fn(), findFirst: vi.fn() },
  wantListItem: { findFirst: vi.fn(), create: vi.fn() },
  card: { findUnique: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

// ioredis singleton — get/set/del/keys as spies; keep the REAL RedisKeys so the
// assertions use the production key builders.
const redisMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  keys: vi.fn(),
}));
vi.mock("@/lib/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/redis")>();
  return { ...actual, redis: redisMock };
});

import { POST as collectionsPost } from "@/app/api/collections/route";
import { POST as wantListPost } from "@/app/api/want-list/route";
import { RedisKeys } from "@/lib/redis";

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockResolvedValue("OK");
  redisMock.del.mockResolvedValue(1);
  redisMock.keys.mockResolvedValue([]);
});

describe("collection create invalidation", () => {
  it("deletes collections:{userId} AND dashboard:{userId} after a successful create", async () => {
    prismaMock.collection.create.mockResolvedValue({
      id: "col_1",
      userId: USER_ID,
      name: "Vintage",
      isPrivate: true,
      typeTag: "MIXED",
    });

    const res = await collectionsPost(
      jsonRequest("http://localhost/api/collections", { name: "Vintage" })
    );
    expect(res.status).toBe(201);

    const delArgs = redisMock.del.mock.calls.flat();
    expect(delArgs).toContain(RedisKeys.collections(USER_ID));
    expect(delArgs).toContain(RedisKeys.dashboardData(USER_ID));
  });
});

describe("want-list add invalidation", () => {
  it("deletes the wantlist:{userId}:* family AND dashboard:{userId}", async () => {
    // The whole family is scanned via redis.keys(pattern) then deleted.
    const family = [RedisKeys.wantList(USER_ID, "BUY"), RedisKeys.wantList(USER_ID, "all")];
    redisMock.keys.mockResolvedValue(family);
    // addWantListItem is findFirst (no existing row) + create, not an upsert.
    prismaMock.wantListItem.findFirst.mockResolvedValue(null);
    prismaMock.wantListItem.create.mockResolvedValue({
      id: "wl_1",
      userId: USER_ID,
      cardId: "base1-4",
      intent: "BUY",
    });

    const res = await wantListPost(
      jsonRequest("http://localhost/api/want-list", { cardId: "base1-4", intent: "BUY" })
    );
    expect(res.status).toBe(201);

    expect(redisMock.keys).toHaveBeenCalledWith(RedisKeys.wantListPattern(USER_ID));
    const delArgs = redisMock.del.mock.calls.flat();
    expect(delArgs).toContain(RedisKeys.dashboardData(USER_ID));
    for (const k of family) expect(delArgs).toContain(k);
  });
});
