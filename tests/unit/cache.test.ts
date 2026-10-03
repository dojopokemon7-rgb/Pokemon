import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Fail-open cache helper + per-user key classification tests.
 *
 * Proves AGENTS.md RULE 1 (Redis is fail-open: any error → cache miss, never a
 * throw) and RULE 5 (every per-user key embeds the userId; user-agnostic card
 * keys never do — a key missing userId would leak one user's private data).
 */

// Mock the ioredis singleton so we can simulate Redis-down / malformed payloads
// without a live Redis. Expose get/set/del/keys as vi.fn() and keep the REAL
// RedisKeys registry so the key-classification assertions test production keys.
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

import {
  cacheGetJson,
  cacheSetJson,
  invalidateUserCaches,
} from "@/lib/utils/cache";
import { RedisKeys } from "@/lib/redis";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cacheGetJson — fail-open", () => {
  it("returns null (not a throw) when Redis is down", async () => {
    redisMock.get.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(cacheGetJson("k")).resolves.toBeNull();
  });

  it("returns null on a malformed/legacy payload", async () => {
    redisMock.get.mockResolvedValueOnce("{ not json");
    await expect(cacheGetJson("k")).resolves.toBeNull();
  });

  it("returns null on a miss", async () => {
    redisMock.get.mockResolvedValueOnce(null);
    await expect(cacheGetJson("k")).resolves.toBeNull();
  });

  it("parses and returns a cached value on a hit", async () => {
    redisMock.get.mockResolvedValueOnce(JSON.stringify({ a: 1 }));
    await expect(cacheGetJson<{ a: number }>("k")).resolves.toEqual({ a: 1 });
  });
});

describe("cacheSetJson — fail-open", () => {
  it("does not throw when Redis write fails", async () => {
    redisMock.set.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(cacheSetJson("k", { a: 1 }, 60)).resolves.toBeUndefined();
  });

  it("writes serialized JSON with an EX ttl", async () => {
    redisMock.set.mockResolvedValueOnce("OK");
    await cacheSetJson("k", { a: 1 }, 90);
    expect(redisMock.set).toHaveBeenCalledWith("k", JSON.stringify({ a: 1 }), "EX", 90);
  });
});

describe("RedisKeys — RULE 5 per-user key classification", () => {
  const U = "user_abc123";

  it("per-user keys CONTAIN the userId", () => {
    expect(RedisKeys.userCollection(U)).toContain(U);
    expect(RedisKeys.dashboardData(U)).toContain(U);
    expect(RedisKeys.wantList(U, "BUY")).toContain(U);
    expect(RedisKeys.wantList(U)).toContain(U); // "all"
    expect(RedisKeys.collections(U)).toContain(U);
    expect(RedisKeys.wantListPattern(U)).toContain(U);
  });

  it("user-agnostic card keys do NOT contain any userId", () => {
    const search = RedisKeys.cardSearchResult({
      game: "pokemon",
      query: "charizard",
      sort: "market_desc",
    });
    expect(search).not.toContain(U);
    expect(RedisKeys.cardPrices("base1-4")).not.toContain(U);
    expect(RedisKeys.cardHistory("base1-4")).not.toContain(U);
    expect(RedisKeys.cardPopulation("base1-4")).not.toContain(U);
  });

  it("search key normalizes query case (Char == char)", () => {
    const a = RedisKeys.cardSearchResult({ game: "pokemon", query: "Char", sort: "market_desc" });
    const b = RedisKeys.cardSearchResult({ game: "pokemon", query: "char", sort: "market_desc" });
    expect(a).toBe(b);
  });
});

describe("invalidateUserCaches — best-effort delete", () => {
  const U = "user_xyz";

  it("deletes userCollection + dashboard for a collection-item mutation", async () => {
    redisMock.del.mockResolvedValueOnce(2);
    await invalidateUserCaches(U, ["collection", "dashboard"]);
    expect(redisMock.del).toHaveBeenCalledWith(
      RedisKeys.userCollection(U),
      RedisKeys.dashboardData(U)
    );
  });

  it("deletes the want-list family (scanned keys) + dashboard", async () => {
    const family = [RedisKeys.wantList(U, "BUY"), RedisKeys.wantList(U, "all")];
    redisMock.keys.mockResolvedValueOnce(family);
    redisMock.del.mockResolvedValueOnce(family.length + 1);
    await invalidateUserCaches(U, ["wantlist", "dashboard"]);
    expect(redisMock.keys).toHaveBeenCalledWith(RedisKeys.wantListPattern(U));
    expect(redisMock.del).toHaveBeenCalledWith(
      RedisKeys.dashboardData(U),
      ...family
    );
  });

  it("deletes collections + dashboard for a collection CRUD mutation", async () => {
    redisMock.del.mockResolvedValueOnce(2);
    await invalidateUserCaches(U, ["collections", "dashboard"]);
    expect(redisMock.del).toHaveBeenCalledWith(
      RedisKeys.dashboardData(U),
      RedisKeys.collections(U)
    );
  });

  it("does not throw when redis.del rejects", async () => {
    redisMock.del.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(invalidateUserCaches(U, ["collection", "dashboard"])).resolves.toBeUndefined();
  });
});
