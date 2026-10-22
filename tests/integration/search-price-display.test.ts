import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Audit 02 F-F — the min/max price-range filter on /api/cards/search must
 * predicate on the DISPLAYED price (`pickHeadlineRaw(raw) ?? marketPrice`),
 * not on Card.marketPrice alone. These mock Prisma so the only thing under
 * test is (a) the where-shape threaded into findMany and (b) which mocked rows
 * survive into the 200 body.
 */

const prismaMock = vi.hoisted(() => ({ card: { findMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const cacheMock = vi.hoisted(() => ({
  cacheGetJson: vi.fn(async (_k: string): Promise<unknown> => null),
  cacheSetJson: vi.fn(async (..._a: unknown[]) => undefined),
}));
vi.mock("@/lib/utils/cache", () => cacheMock);

vi.mock("@/lib/services/card-search-index.service", () => ({
  isSearchIndexEnabled: vi.fn(() => false),
  searchIndexIds: vi.fn(async () => null),
}));

import { GET } from "@/app/api/cards/search/route";

const call = (qs: string) => GET(new Request(`http://localhost/api/cards/search?${qs}`));
const findWhere = () =>
  prismaMock.card.findMany.mock.calls.at(-1)![0].where as {
    AND: unknown[];
    marketPrice?: unknown;
  };

const row = (over: Record<string, unknown>) => ({
  externalId: "x",
  name: "x",
  number: "1",
  printing: null,
  rarity: "Rare",
  types: [],
  tags: [],
  imageUrl: "u",
  imageUrlHi: null,
  marketPrice: null,
  weeklyChangePct: null,
  currentPrices: [],
  set: { name: "Base" },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  cacheMock.cacheGetJson.mockResolvedValue(null);
});

describe("GET /api/cards/search — F-F display-price range filter", () => {
  it("(a) where carries a raw-priceMarket bound AND a marketPrice arm guarded by currentPrices.none", async () => {
    prismaMock.card.findMany.mockResolvedValue([]);
    // Browse mode (empty query + filter) so no 400; price range is the filter.
    await call("game=pokemon&minPrice=10&maxPrice=100");
    const where = findWhere();
    const json = JSON.stringify(where.AND);
    // arm 1: raw CurrentPrice priceMarket within bounds.
    expect(json).toContain(
      '{"currentPrices":{"some":{"type":"raw","priceMarket":{"gte":10,"lte":100}}}}'
    );
    // arm 2: marketPrice in bounds, guarded by "no raw priceMarket row".
    expect(json).toContain('{"currentPrices":{"none":{"type":"raw","priceMarket":{"not":null}}}}');
    expect(json).toContain('{"marketPrice":{"gte":10,"lte":100}}');
    // The old top-level marketPrice-only spread is gone (range lives under AND).
    expect(where.marketPrice).toBeUndefined();
  });

  it("(b) a row with a raw CurrentPrice in range but marketPrice:null is INCLUDED", async () => {
    // Prisma would filter this in SQL; the mock returns it to prove the route
    // SURFACES it (marketPrice:null + a real raw row → displayed raw price).
    prismaMock.card.findMany.mockResolvedValue([
      row({
        externalId: "in-range-raw",
        marketPrice: null,
        currentPrices: [{ variant: "normal", type: "raw", condition: "NM", company: null, grade: null, priceMarket: 50, priceLow: null }],
      }),
    ]);
    const res = await call("game=pokemon&minPrice=10&maxPrice=100");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cards.map((c: { id: string }) => c.id)).toContain("in-range-raw");
    // Displayed price is the raw row, not null.
    expect(body.cards[0].marketPrice).toBe(50);
  });

  it("(c) a row whose displayed price is outside the range is excluded by the predicate", async () => {
    // The predicate is enforced in SQL; the mock stands in for Prisma having
    // ALREADY excluded the out-of-range card — the route returns the empty set
    // as a 404 (RULE 7: zero matches → 404, never 5xx), proving no out-of-range
    // row is fabricated into the body.
    prismaMock.card.findMany.mockResolvedValue([]);
    const res = await call("game=pokemon&minPrice=10&maxPrice=100");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.source).toBe("local-db");
  });
});
