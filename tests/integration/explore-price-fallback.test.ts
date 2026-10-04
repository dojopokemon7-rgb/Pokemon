import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * FEAT-002 — Explore/trending tile price fallback.
 *
 * BUG 2: tiles showed "No price data" for cards that DO have a real NM
 * CurrentPrice because the list routes selected only Card.marketPrice. Both
 * /api/cards/search and /api/cards/trending now map the tile price as
 * `currentPrices[0].priceMarket ?? Card.marketPrice ?? null` (same source the
 * card-detail route reads). This pins that mapping end to end:
 *   (a) marketPrice null + NM currentPrice 12.5 → 12.5
 *   (b) marketPrice 7     + no currentPrice      → 7
 *   (c) marketPrice null  + no currentPrice      → null  (tile renders '—')
 */

const dbMock = vi.hoisted(() => ({
  prisma: {
    card: {
      findMany: vi.fn((..._args: unknown[]) => Promise.resolve([] as unknown[])),
      count: vi.fn(async () => 0),
    },
    userCollection: {
      groupBy: vi.fn(async () => [] as unknown[]),
    },
  },
}));
vi.mock("@/lib/db", () => dbMock);

// Search route reads cacheGetJson before the DB — force a miss so the mocked
// findMany is always exercised.
vi.mock("@/lib/utils/cache", () => ({
  cacheGetJson: vi.fn(async () => null),
  cacheSetJson: vi.fn(async () => {}),
}));

// Trending route reads/writes Redis directly — miss on read, noop on write.
vi.mock("@/lib/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/redis")>();
  return {
    ...actual,
    redis: { get: vi.fn(async () => null), set: vi.fn(async () => "OK") },
  };
});

import { GET as searchGET } from "@/app/api/cards/search/route";
import { GET as trendingGET } from "@/app/api/cards/trending/route";

// A mocked Card row for the search route. externalId carries the game prefix
// via the joined set so the query returns 200.
function searchRow(marketPrice: number | null, currentPrices: { priceMarket: number | null }[]) {
  return {
    externalId: "base1-4",
    name: "Charizard",
    number: "4",
    rarity: "Rare Holo",
    types: ["Fire"],
    imageUrl: "https://img/charizard.png",
    imageUrlHi: null,
    marketPrice,
    currentPrices,
    set: { name: "Base" },
  };
}

function trendingRow(marketPrice: number | null, currentPrices: { priceMarket: number | null }[]) {
  return {
    id: "ckcard1",
    externalId: "base1-4",
    name: "Charizard",
    imageUrl: "https://img/charizard.png",
    imageUrlHi: null,
    marketPrice,
    currentPrices,
    rarity: "Rare Holo",
    set: { name: "Base" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.prisma.card.count.mockResolvedValue(1);
  dbMock.prisma.userCollection.groupBy.mockResolvedValue([]);
});

describe("GET /api/cards/search — tile price fallback", () => {
  async function priceFor(row: ReturnType<typeof searchRow>): Promise<number | null> {
    dbMock.prisma.card.findMany.mockResolvedValue([row]);
    const res = await searchGET(
      new Request("http://localhost/api/cards/search?game=pokemon&query=char")
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cards: { marketPrice: number | null }[] };
    return body.cards[0].marketPrice;
  }

  it("(a) null marketPrice + NM currentPrice → the currentPrice", async () => {
    expect(await priceFor(searchRow(null, [{ priceMarket: 12.5 }]))).toBe(12.5);
  });

  it("(b) marketPrice set + no currentPrice → marketPrice", async () => {
    expect(await priceFor(searchRow(7, []))).toBe(7);
  });

  it("(c) neither → null (tile renders NoPriceText)", async () => {
    expect(await priceFor(searchRow(null, []))).toBeNull();
  });
});

describe("GET /api/cards/trending — tile price fallback", () => {
  async function priceFor(row: ReturnType<typeof trendingRow>): Promise<number | null> {
    // sort=market_desc avoids the page-1 ranked/backfill path's extra reads;
    // the plain offset branch returns our single mocked row directly.
    dbMock.prisma.card.findMany.mockResolvedValue([row]);
    const res = await trendingGET(
      new Request("http://localhost/api/cards/trending?game=pokemon&sort=market_desc")
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cards: { price: number | null }[] };
    return body.cards[0].price;
  }

  it("(a) null marketPrice + NM currentPrice → the currentPrice", async () => {
    expect(await priceFor(trendingRow(null, [{ priceMarket: 12.5 }]))).toBe(12.5);
  });

  it("(b) marketPrice set + no currentPrice → marketPrice", async () => {
    expect(await priceFor(trendingRow(7, []))).toBe(7);
  });

  it("(c) neither → null (tile renders NoPriceText)", async () => {
    expect(await priceFor(trendingRow(null, []))).toBeNull();
  });
});
