import { describe, it, expect, vi, beforeEach } from "vitest";

/** FEAT-003 — browse mode (empty query + filter) on /api/cards/search and the filter-options route. */
const dbMock = vi.hoisted(() => ({
  prisma: {
    card: { findMany: vi.fn((..._a: unknown[]) => Promise.resolve([] as unknown[])) },
    cardSet: { findMany: vi.fn((..._a: unknown[]) => Promise.resolve([] as unknown[])) },
  },
}));
vi.mock("@/lib/db", () => dbMock);
vi.mock("@/lib/utils/cache", () => ({
  cacheGetJson: vi.fn(async () => null),
  cacheSetJson: vi.fn(async () => {}),
}));

import { GET as searchGET } from "@/app/api/cards/search/route";
import { GET as optionsGET } from "@/app/api/cards/filter-options/route";

const row = {
  externalId: "bw1b_ja-3", name: "Pikachu", number: "3", rarity: "Common", types: [],
  imageUrl: "https://img/p.png", imageUrlHi: null, marketPrice: 2, currentPrices: [], set: { name: "BW" },
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.prisma.card.findMany.mockResolvedValue([row]);
});

describe("GET /api/cards/search browse mode", () => {
  it("empty query + language=ja → 200, price-desc order, image predicate kept", async () => {
    const res = await searchGET(new Request("http://localhost/api/cards/search?game=pokemon&language=ja"));
    expect(res.status).toBe(200);
    const args = dbMock.prisma.card.findMany.mock.calls[0][0] as {
      orderBy: unknown; where: { AND: unknown[]; OR?: unknown };
    };
    expect(args.orderBy).toEqual([{ marketPrice: { sort: "desc", nulls: "last" } }, { externalId: "asc" }]);
    expect(JSON.stringify(args.where.AND)).toContain('"imageUrl"');
    expect(JSON.stringify(args.where.AND)).toContain("_ja-");
    expect(JSON.stringify(args.where)).not.toContain('"name":{"contains"');
  });

  it("empty query without filters → 400", async () => {
    const res = await searchGET(new Request("http://localhost/api/cards/search?game=pokemon&query="));
    expect(res.status).toBe(400);
    expect(dbMock.prisma.card.findMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/cards/filter-options", () => {
  it("returns Zod-valid sets + rarities, dropping empty/Unknown", async () => {
    dbMock.prisma.cardSet.findMany.mockResolvedValue([{ name: "Base" }, { name: "" }]);
    dbMock.prisma.card.findMany.mockResolvedValue([{ rarity: "Rare" }, { rarity: "Unknown" }, { rarity: null }]);
    const res = await optionsGET(new Request("http://localhost/api/cards/filter-options?game=pokemon"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sets: ["Base"], rarities: ["Rare"] });
  });

  it("200 + empty arrays on DB error", async () => {
    dbMock.prisma.cardSet.findMany.mockRejectedValue(new Error("db down"));
    const res = await optionsGET(new Request("http://localhost/api/cards/filter-options?game=pokemon"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sets: [], rarities: [] });
  });
});

