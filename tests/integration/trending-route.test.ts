import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Audit 02 F-S (RULE 2) — /api/cards/trending must map the REAL stored
 * Card.weeklyChangePct into the tile's delta/up, and emit null (never a
 * fabricated value) when a card has no recorded change. Prisma + Redis are
 * MOCKED (no live DB/network). Redis reads return null so the live query
 * path runs; groupBy returns [] so the backfill path supplies the page.
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

const call = (qs = "game=pokemon") =>
  GET(new Request(`http://localhost/api/cards/trending?${qs}`));

// A trending row as narrowed by TRENDING_SELECT.
const row = (id: string, weeklyChangePct: number | null) => ({
  id,
  externalId: id,
  name: "Charizard",
  imageUrl: "u",
  imageUrlHi: null,
  marketPrice: 10,
  printing: null,
  currentPrices: [],
  rarity: null,
  weeklyChangePct,
  set: { name: "Base" },
});

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockResolvedValue(null);
  // No recent collection-adds → ranked set is empty → backfill findMany runs.
  prismaMock.userCollection.groupBy.mockResolvedValue([]);
  prismaMock.card.count.mockResolvedValue(1);
});

describe("GET /api/cards/trending weekly delta", () => {
  it("maps a real positive weeklyChangePct to delta:'+7.1%', up:true", async () => {
    prismaMock.card.findMany.mockResolvedValue([row("base1-4", 7.1)]);
    const body = await (await call()).json();
    expect(body.cards[0]).toMatchObject({ delta: "+7.1%", up: true });
  });

  it("maps a real negative weeklyChangePct to delta:'-2.5%', up:false", async () => {
    prismaMock.card.findMany.mockResolvedValue([row("base1-4", -2.5)]);
    const body = await (await call()).json();
    expect(body.cards[0]).toMatchObject({ delta: "-2.5%", up: false });
  });

  it("emits delta:null, up:null when there is no recorded change (RULE 2)", async () => {
    prismaMock.card.findMany.mockResolvedValue([row("base1-4", null)]);
    const body = await (await call()).json();
    expect(body.cards[0].delta).toBeNull();
    expect(body.cards[0].up).toBeNull();
  });
});
