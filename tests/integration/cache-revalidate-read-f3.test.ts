import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Audit 12 F3 (RULE 4) — GET /api/cards/trending must re-parse its Redis-cached
 * blob with the OUTPUT Zod schema and treat a WRONG-shape blob as a cache MISS
 * (fall through to the live query, which re-caches the correct shape), never
 * serve it verbatim. Redis + Prisma are MOCKED — no live DB/network.
 *
 * Sibling sites touched by the same fix have their own files:
 *   ebay-search → cache-revalidate-read-ebay.test.ts
 *   dashboard   → cache-revalidate-read-dashboard.test.ts
 * (search + prices/history were ALREADY-OK — see cache-revalidate-read.test.ts.)
 */

const prismaMock = vi.hoisted(() => ({
  card: { count: vi.fn(), findMany: vi.fn() },
  userCollection: { groupBy: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const redisMock = vi.hoisted(() => ({
  get: vi.fn(async (_k: string): Promise<string | null> => null),
  set: vi.fn(async (..._a: unknown[]) => undefined),
}));
vi.mock("@/lib/redis", () => ({ redis: redisMock }));

import { GET } from "@/app/api/cards/trending/route";

const liveRow = {
  id: "base1-4",
  externalId: "base1-4",
  name: "Charizard",
  imageUrl: "u",
  imageUrlHi: null,
  marketPrice: 10,
  printing: null,
  currentPrices: [],
  rarity: null,
  weeklyChangePct: 7.1,
  set: { name: "Base" },
};

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockResolvedValue(null);
  prismaMock.userCollection.groupBy.mockResolvedValue([]);
  prismaMock.card.count.mockResolvedValue(1);
});

describe("GET /api/cards/trending — re-validate cached read (audit 12 F3)", () => {
  it("treats a WRONG-shape cached blob as a miss and serves the live query", async () => {
    // Stale/old-shape blob: `cards` is not an array, `nextCursor` missing.
    redisMock.get.mockResolvedValue(JSON.stringify({ cards: "nope" }));
    prismaMock.card.findMany.mockResolvedValue([liveRow]);

    const res = await GET(
      new Request("http://localhost/api/cards/trending?game=pokemon")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    // Fell through to the live query (the stale blob was NOT served).
    expect(prismaMock.card.findMany).toHaveBeenCalled();
    expect(body.cards[0]).toMatchObject({ externalId: "base1-4", delta: "+7.1%" });
    // The live path re-caches the correct shape.
    expect(redisMock.set).toHaveBeenCalled();
  });

  it("treats a malformed (non-JSON) cached blob as a miss and serves the live query", async () => {
    redisMock.get.mockResolvedValue("not-json{");
    prismaMock.card.findMany.mockResolvedValue([liveRow]);

    const res = await GET(
      new Request("http://localhost/api/cards/trending?game=pokemon")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(prismaMock.card.findMany).toHaveBeenCalled();
    expect(body.cards[0].externalId).toBe("base1-4");
  });

  it("serves a VALID cached blob without hitting the DB", async () => {
    redisMock.get.mockResolvedValue(
      JSON.stringify({
        cards: [
          {
            id: "base1-4",
            externalId: "base1-4",
            name: "Charizard",
            setImage: "Base",
            imageUrl: "u",
            price: 10,
            rarity: null,
            printing: null,
            delta: "+7.1%",
            up: true,
          },
        ],
        nextCursor: null,
      })
    );

    const res = await GET(
      new Request("http://localhost/api/cards/trending?game=pokemon")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(prismaMock.card.findMany).not.toHaveBeenCalled();
    expect(body.cards[0].externalId).toBe("base1-4");
  });
});
