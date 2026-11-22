import { describe, it, expect, vi, beforeEach } from "vitest";
/**
 * Variant (printing) search: explicit `variant` filter, text-query inference,
 * cache key, composition with other filters + offset pagination, and the
 * filter-options `variants` list. Prisma + cache are mocked (no DB / Redis).
 */
const dbMock = vi.hoisted(() => ({
  prisma: {
    card: {
      findMany: vi.fn((..._a: unknown[]) => Promise.resolve([] as unknown[])),
      groupBy: vi.fn((..._a: unknown[]) => Promise.resolve([] as unknown[])),
    },
    cardSet: { findMany: vi.fn((..._a: unknown[]) => Promise.resolve([] as unknown[])) },
  },
}));
vi.mock("@/lib/db", () => dbMock);
const cacheMock = vi.hoisted(() => ({
  cacheGetJson: vi.fn(async (_k: string): Promise<unknown> => null),
  cacheSetJson: vi.fn(async (..._a: unknown[]) => undefined),
}));
vi.mock("@/lib/utils/cache", () => cacheMock);
vi.mock("@/lib/services/card-search-index.service", () => ({
  isSearchIndexEnabled: vi.fn(() => true),
  searchIndexIds: vi.fn(async () => ["x"]),
}));

import { GET as searchGET } from "@/app/api/cards/search/route";
import { GET as optionsGET } from "@/app/api/cards/filter-options/route";

const row = (externalId: string, printing: string | null) => ({
  externalId, name: "Charizard", number: "4", printing, rarity: "Rare", types: [], tags: [],
  imageUrl: "https://img/c.png", imageUrlHi: null, marketPrice: 5, weeklyChangePct: null,
  currentPrices: [], set: { name: "Base" },
});
const call = (qs: string) => searchGET(new Request(`http://localhost/api/cards/search?${qs}`));
const wheres = () => dbMock.prisma.card.findMany.mock.calls.map((c) => JSON.stringify((c[0] as { where: unknown }).where));
const printingEquals = (w: string, v: string) => w.includes(`"printing":{"equals":"${v}","mode":"insensitive"}`);
const printingIn = (w: string, v: string[]) => w.includes(`"printing":{"in":${JSON.stringify(v)}}`);

beforeEach(() => {
  vi.clearAllMocks();
  cacheMock.cacheGetJson.mockResolvedValue(null);
  dbMock.prisma.card.findMany.mockResolvedValue([row("base1-4::reverse holofoil", "reverse holofoil")]);
  dbMock.prisma.card.groupBy.mockResolvedValue([
    { printing: "normal" }, { printing: "reverseHolofoil" }, { printing: "reverse holofoil" }, { printing: "holofoil" },
  ]);
});

describe("GET /api/cards/search ?variant=", () => {
  it("applies a case-insensitive printing filter over every stored spelling and returns the label", async () => {
    const res = await call("game=pokemon&query=charizard&variant=reverse%20holofoil&sort=market_desc");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cards[0].printing).toBe("reverse holofoil");
    expect(body.inferredVariant).toBeNull();
    const w = wheres()[0];
    // exact IN over the catalog's own stored spellings (cheap, no ILIKE)
    expect(printingIn(w, ["reverseHolofoil", "reverse holofoil"])).toBe(true);
    expect(w).not.toContain('"printing":{"equals"');
    // composes with the always-on image filter and the game scope
    expect(w).toContain('"imageUrl"');
    expect(w).toContain('"startsWith":"pokemon-"');
  });

  it("accepts a camelCase spelling (same filter as the spaced one)", async () => {
    await call("game=pokemon&query=charizard&variant=reverseHolofoil");
    expect(printingIn(wheres()[0], ["reverseHolofoil", "reverse holofoil"])).toBe(true);
  });

  it("a key with no known stored spelling falls back to case-insensitive equality over plausible spellings", async () => {
    dbMock.prisma.card.groupBy.mockResolvedValue([]);
    await call("game=pokemon&query=charizard&variant=reverse%20holofoil");
    const w = wheres()[0];
    for (const s of ["reverse holofoil", "reverse-holofoil", "reverse_holofoil", "reverseholofoil"]) expect(printingEquals(w, s)).toBe(true);
    expect(w).not.toContain(`"printing":{"in"`);
  });

  it("variant alone is browse mode (valid without a query), offset pagination intact", async () => {
    dbMock.prisma.card.findMany.mockResolvedValue(Array.from({ length: 61 }, (_, i) => row(`id-${i}`, "holofoil")));
    const res = await call("game=pokemon&variant=holofoil&cursor=60&set=Base&rarity=Rare");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cards).toHaveLength(60);
    expect(body.nextCursor).toBe(120);
    const args = dbMock.prisma.card.findMany.mock.calls.at(-1)![0] as { skip: number; take: number; where: unknown };
    expect(args.skip).toBe(60);
    expect(args.take).toBe(61);
    const w = JSON.stringify(args.where);
    expect(printingIn(w, ["holofoil"])).toBe(true);
    expect(w).toContain('"name":{"equals":"Base"');
    expect(w).toContain('"rarity":{"contains":"Rare"');
  });

  it("the variant is part of the cache key (no cross-variant cache hits) and is not cached under another variant's key", async () => {
    await call("game=pokemon&query=charizard&variant=holofoil&sort=market_desc");
    await call("game=pokemon&query=charizard&variant=normal&sort=market_desc");
    await call("game=pokemon&query=charizard&sort=market_desc");
    const keys = cacheMock.cacheSetJson.mock.calls.map((c) => c[0] as string).filter((k) => k.startsWith("card:searchq:"));
    expect(keys[0]).toContain("variant=holofoil");
    expect(keys[1]).toContain("variant=normal");
    expect(keys[2]).toContain("variant=|");
    expect(new Set(keys).size).toBe(3);
  });

  it("a cached payload with a bad card shape is ignored (Zod re-parse) and the live query runs", async () => {
    cacheMock.cacheGetJson.mockResolvedValueOnce({ cards: [{ nope: 1 }], source: "local-db" });
    const res = await call("game=pokemon&query=charizard&variant=holofoil&sort=market_desc");
    expect(res.status).toBe(200);
    expect(dbMock.prisma.card.findMany).toHaveBeenCalled();
  });

  it("invalid variant → 400 like other invalid filters; unknown well-formed variant → plain 404 zero matches", async () => {
    expect((await call("game=pokemon&query=a&variant=%3Cscript%3E")).status).toBe(400);
    expect((await call(`game=pokemon&query=a&variant=${"x".repeat(41)}`)).status).toBe(400);
    dbMock.prisma.card.findMany.mockResolvedValue([]);
    expect((await call("game=pokemon&query=charizard&variant=nonexistent&sort=market_desc")).status).toBe(404);
  });

  it("variant=any means no filter (no printing predicate)", async () => {
    await call("game=pokemon&query=charizard&variant=any&sort=market_desc");
    expect(wheres()[0]).not.toContain('"printing"');
  });

  it("skips the Typesense index while a variant filter is active", async () => {
    const idx = await import("@/lib/services/card-search-index.service");
    await call("game=pokemon&query=charizard&variant=holofoil");
    expect(idx.searchIndexIds).not.toHaveBeenCalled();
  });
});

describe("GET /api/cards/search text-query variant inference", () => {
  it("'charizard reverse holo' → strips the phrase, filters reverse holofoil, reports inferredVariant", async () => {
    const res = await call("game=pokemon&query=charizard%20reverse%20holo&sort=market_desc");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inferredVariant).toEqual({ value: "reverse holofoil", label: "Reverse Holo" });
    const w = wheres().at(-1)!;
    expect(printingIn(w, ["reverseHolofoil", "reverse holofoil"])).toBe(true);
    expect(w).toContain('"name":{"contains":"charizard"');
    expect(w).not.toContain("holo\",\"mode\"");
    // cache key uses the stripped query + effective variant
    const key = cacheMock.cacheSetJson.mock.calls.map((c) => c[0] as string).filter((k) => k.startsWith("card:searchq:")).at(-1)!;
    expect(key).toContain("q=charizard|");
    expect(key).toContain("variant=reverse holofoil");
  });

  it("explicit variant wins over a phrase in the text (no inference, text untouched)", async () => {
    const res = await call("game=pokemon&query=charizard%20reverse%20holo&variant=normal&sort=market_desc");
    expect((await res.json()).inferredVariant).toBeNull();
    const w = wheres().at(-1)!;
    expect(printingIn(w, ["normal"])).toBe(true);
    expect(printingIn(w, ["reverseHolofoil", "reverse holofoil"])).toBe(false);
    expect(w).toContain('"name":{"contains":"charizard reverse holo"');
  });

  it("variant-only text and rarity names are NOT inferred", async () => {
    for (const q of ["holo", "reverse%20holo", "charizard%20rare%20holo"]) {
      dbMock.prisma.card.findMany.mockClear();
      const body = await (await call(`game=pokemon&query=${q}&sort=market_desc`)).json();
      expect(body.inferredVariant).toBeNull();
      expect(wheres().at(-1)).not.toContain('"printing"');
    }
  });

  it("nothing is inferred when the game has no such printing data (honest degrade)", async () => {
    dbMock.prisma.card.groupBy.mockResolvedValue([]);
    const body = await (await call("game=pokemon&query=charizard%20reverse%20holo&sort=market_desc")).json();
    expect(body.inferredVariant).toBeNull();
    const w = wheres().at(-1)!;
    expect(w).not.toContain('"printing"');
    expect(w).toContain('"name":{"contains":"charizard reverse holo"');
  });

  it("'charizard 1st edition' expands to the existing first-edition printings", async () => {
    dbMock.prisma.card.groupBy.mockResolvedValue([{ printing: "firstEditionHolofoil" }, { printing: "normal" }]);
    const body = await (await call("game=pokemon&query=charizard%201st%20edition&sort=market_desc")).json();
    expect(body.inferredVariant).toEqual({ value: "first edition", label: "1st Edition" });
    expect(printingIn(wheres().at(-1)!, ["firstEditionHolofoil"])).toBe(true);
  });
});

describe("GET /api/cards/filter-options variants", () => {
  it("returns distinct, spelling-collapsed variants with friendly labels; null printings excluded in the query", async () => {
    dbMock.prisma.cardSet.findMany.mockResolvedValue([{ name: "Base" }]);
    const res = await optionsGET(new Request("http://localhost/api/cards/filter-options?game=pokemon"));
    const body = await res.json();
    expect(body.variants).toEqual([
      { value: "holofoil", label: "Holo" },
      { value: "normal", label: "Normal" },
      { value: "reverse holofoil", label: "Reverse Holo" },
    ]);
    const args = dbMock.prisma.card.groupBy.mock.calls[0][0] as { where: { printing: unknown } };
    expect(args.where.printing).toEqual({ not: null });
  });

  it("returns an empty list (UI hides the filter) when no printing data exists", async () => {
    dbMock.prisma.card.groupBy.mockResolvedValue([]);
    const body = await (await optionsGET(new Request("http://localhost/api/cards/filter-options?game=onepiece"))).json();
    expect(body.variants).toEqual([]);
  });
});
