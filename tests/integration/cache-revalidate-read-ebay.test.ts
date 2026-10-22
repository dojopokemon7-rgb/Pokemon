import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Audit 12 F3 (RULE 4) — GET /api/ebay/search must re-parse its Redis-cached
 * listing array with a Zod schema and treat a WRONG-shape blob as a cache MISS
 * (fall through to the live eBay call, which re-caches the correct shape),
 * never cast + serve it verbatim. Redis + the eBay service + the rate limiter
 * are MOCKED — no live network.
 */

const redisMock = vi.hoisted(() => ({
  get: vi.fn(async (_k: string): Promise<string | null> => null),
  set: vi.fn(async (..._a: unknown[]) => undefined),
}));
vi.mock("@/lib/redis", () => ({
  redis: redisMock,
  RedisKeys: { ebaySearch: (k: string) => `ebay:search:${k}` },
}));

const ebaySvcMock = vi.hoisted(() => ({
  searchEbayListings: vi.fn(),
}));
vi.mock("@/lib/services/ebay.service", () => ebaySvcMock);

// Rate limiter fails open (allows) in tests; stub it to null so it never 429s.
vi.mock("@/lib/utils/rate-limit", () => ({
  enforceRateLimit: vi.fn(async () => null),
  searchTier: vi.fn(() => ({ bucket: "search", limit: 60, windowSeconds: 60 })),
  clientIp: vi.fn(() => "127.0.0.1"),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/ebay/search/route";

const liveListing = {
  itemId: "v1|123|0",
  title: "Charizard Base",
  price: 42.5,
  currency: "USD",
  imageUrl: "https://img",
  itemWebUrl: "https://ebay/itm/123",
};

const call = () =>
  GET(new NextRequest("http://localhost/api/ebay/search?name=charizard&game=pokemon"));

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockResolvedValue(null);
});

describe("GET /api/ebay/search — re-validate cached read (audit 12 F3)", () => {
  it("treats a WRONG-shape cached blob as a miss and serves the live call", async () => {
    // Old/wrong shape: price is a string, not a number.
    redisMock.get.mockResolvedValue(
      JSON.stringify([{ itemId: "x", title: "t", price: "42.5", currency: "USD", imageUrl: null, itemWebUrl: "u" }])
    );
    ebaySvcMock.searchEbayListings.mockResolvedValue([liveListing]);

    const res = await call();
    const body = await res.json();

    expect(res.status).toBe(200);
    // Fell through to the live call (the stale blob was NOT served).
    expect(ebaySvcMock.searchEbayListings).toHaveBeenCalled();
    expect(body.source).toBe("live");
    expect(body.listings).toEqual([liveListing]);
    // The live path re-caches the correct shape.
    expect(redisMock.set).toHaveBeenCalled();
  });

  it("treats a malformed (non-JSON) cached blob as a miss and serves the live call", async () => {
    redisMock.get.mockResolvedValue("not-json{");
    ebaySvcMock.searchEbayListings.mockResolvedValue([liveListing]);

    const res = await call();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(ebaySvcMock.searchEbayListings).toHaveBeenCalled();
    expect(body.source).toBe("live");
  });

  it("serves a VALID cached blob without calling the eBay service", async () => {
    redisMock.get.mockResolvedValue(JSON.stringify([liveListing]));

    const res = await call();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(ebaySvcMock.searchEbayListings).not.toHaveBeenCalled();
    expect(body.source).toBe("cache");
    expect(body.listings).toEqual([liveListing]);
  });
});
