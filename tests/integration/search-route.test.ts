import { describe, it, expect, vi, beforeEach } from "vitest";

/** Epic A — /api/cards/search relevance. Prisma, cache and the index adapter are MOCKED. */

const prismaMock = vi.hoisted(() => ({ card: { findMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const cacheMock = vi.hoisted(() => ({
  cacheGetJson: vi.fn(async (_k: string): Promise<unknown> => null),
  cacheSetJson: vi.fn(async (..._a: unknown[]) => undefined),
}));
vi.mock("@/lib/utils/cache", () => cacheMock);

const indexMock = vi.hoisted(() => ({
  isSearchIndexEnabled: vi.fn(() => false),
  searchIndexIds: vi.fn(async (..._a: unknown[]): Promise<string[] | null> => null),
}));
vi.mock("@/lib/services/card-search-index.service", () => indexMock);

import { GET } from "@/app/api/cards/search/route";

const row = (externalId: string, name: string, number = "1", setName = "Base", marketPrice: number | null = 1) => ({
  externalId, name, number, rarity: "Rare", types: [], tags: [], imageUrl: "u", imageUrlHi: null,
  marketPrice, currentPrices: [], set: { name: setName },
});

const call = (qs: string) => GET(new Request(`http://localhost/api/cards/search?${qs}`));
const wheres = () => prismaMock.card.findMany.mock.calls.map((c) => (c[0] as { where: Record<string, unknown> }).where);

beforeEach(() => {
  vi.clearAllMocks();
  cacheMock.cacheGetJson.mockResolvedValue(null);
  indexMock.isSearchIndexEnabled.mockReturnValue(false);
  prismaMock.card.findMany.mockResolvedValue([row("base1-4", "Charizard", "4/102")]);
});

describe("GET /api/cards/search", () => {
  it("keeps the response shape and 400/404 behavior", async () => {
    const ok = await call("game=pokemon&query=charizard");
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.source).toBe("local-db");
    expect(body.cards[0]).toMatchObject({ id: "base1-4", name: "Charizard", setImage: "Base", hp: null });
    expect((await call("game=pokemon")).status).toBe(400);
    expect((await call("game=pokemon&query=x&sort=bogus")).status).toBe(400);
    prismaMock.card.findMany.mockResolvedValue([]);
    expect((await call("game=pokemon&query=zzzzqq")).status).toBe(404);
  });

  it("caps at 60 results", async () => {
    prismaMock.card.findMany.mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => row(`s-${String(i).padStart(3, "0")}`, "Dog"))
    );
    const body = await (await call("game=pokemon&query=dog")).json();
    expect(body.cards).toHaveLength(60);
  });

  it("ranks exact id first and never returns a different id for identifier queries", async () => {
    prismaMock.card.findMany.mockResolvedValue([row("mee-17", "B", "17"), row("mee-16", "A", "16")]);
    const body = await (await call("game=pokemon&query=mee%2016")).json();
    expect(body.cards.map((c: { id: string }) => c.id)).toEqual(["mee-16"]);
    const miss = await call("game=pokemon&query=mee-18");
    expect(miss.status).toBe(404);
  });

  it("applies filters to every Prisma query, including typo recall", async () => {
    prismaMock.card.findMany.mockResolvedValue([row("x-1", "Raichu")]); // no name hit → stage 2 runs
    await call("game=pokemon&query=charzard&set=Base&rarity=Rare&graded=ungraded&minPrice=1&maxPrice=9");
    const ws = wheres();
    expect(ws.length).toBeGreaterThanOrEqual(2); // stage 1 + stage 2 recall
    for (const w of ws) {
      expect(w.set).toMatchObject({ name: { equals: "Base" } });
      expect(w.rarity).toBeDefined();
      expect(w.NOT).toBeDefined();
      expect(w.marketPrice).toEqual({ gte: 1, lte: 9 });
    }
  });

  it("omitted sort and sort=trending use relevance; explicit sort keeps DB order", async () => {
    prismaMock.card.findMany.mockResolvedValue([row("b-1", "Pikachu V"), row("a-1", "Pikachu")]);
    for (const qs of ["game=pokemon&query=pikachu", "game=pokemon&query=pikachu&sort=trending"]) {
      const body = await (await call(qs)).json();
      expect(body.cards.map((c: { id: string }) => c.id)).toEqual(["a-1", "b-1"]);
    }
    prismaMock.card.findMany.mockClear();
    const body = await (await call("game=pokemon&query=pikachu&sort=market_asc")).json();
    expect(body.cards.map((c: { id: string }) => c.id)).toEqual(["b-1", "a-1"]);
    expect(prismaMock.card.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.card.findMany.mock.calls[0][0].orderBy[0]).toEqual({ marketPrice: { sort: "asc", nulls: "last" } });
  });

  it("uses a different cache key for relevance vs explicit sort", async () => {
    await call("game=pokemon&query=charizard");
    await call("game=pokemon&query=charizard&sort=market_desc");
    const [k1, k2] = cacheMock.cacheSetJson.mock.calls.map((c) => c[0] as string);
    expect(k1).toContain("sort=rel-v2");
    expect(k2).toContain("sort=market_desc");
  });

  it("re-validates cached payloads and treats malformed ones as a miss", async () => {
    cacheMock.cacheGetJson.mockResolvedValue({ cards: [{ bad: true }], source: "local-db" });
    const res = await call("game=pokemon&query=charizard");
    expect(res.status).toBe(200);
    expect(prismaMock.card.findMany).toHaveBeenCalled();
  });
});

describe("hasPrice filter", () => {
  // The exact "has displayable price" OR the WHERE clause must encode. This
  // MUST stay identical to the route's tile-price definition
  // (`currentPrices?.[0]?.priceMarket ?? marketPrice ?? null`): NM/normal
  // CurrentPrice OR Card.marketPrice. If the WHERE and the display diverge,
  // this literal stops matching and the test fails.
  const PRICE_OR = [
    { marketPrice: { not: null } },
    { currentPrices: { some: { variant: "normal", condition: "NM", priceMarket: { not: null } } } },
  ];

  it("adds the price OR (matching the display definition) to every query when ON", async () => {
    prismaMock.card.findMany.mockResolvedValue([row("x-1", "Raichu")]); // no name hit → stage 2 recall too
    await call("game=pokemon&query=charzard&hasPrice=true");
    const ws = wheres();
    expect(ws.length).toBeGreaterThanOrEqual(2); // stage 1 + stage 2 recall
    for (const w of ws) {
      // Folded in as its OWN nested AND so it never clobbers the sibling
      // graded OR or the relevance AND:[{OR:or}].
      const and = w.AND as Array<Record<string, unknown>> | undefined;
      expect(and).toBeDefined();
      expect(and).toEqual(expect.arrayContaining([{ OR: PRICE_OR }]));
    }
  });

  it("does NOT add the price OR when OFF (default) — unpriced cards still returned", async () => {
    // A card with NO marketPrice and NO NM currentPrice is still returned.
    prismaMock.card.findMany.mockResolvedValue([
      { ...row("unpriced-1", "Caterpie", "10", "Base", null), currentPrices: [] },
    ]);
    const body = await (await call("game=pokemon&query=caterpie")).json();
    expect(body.cards.map((c: { id: string }) => c.id)).toContain("unpriced-1");
    for (const w of wheres()) {
      const and = (w.AND as Array<Record<string, unknown>> | undefined) ?? [];
      expect(and).not.toContainEqual({ OR: PRICE_OR });
    }
  });

  it("maps an NM currentPrice with null marketPrice to a visible price (the kept-when-ON case)", async () => {
    // This is the card the WHERE's second OR branch keeps: null marketPrice
    // but a real NM CurrentPrice. The tile must then SHOW that NM price, so a
    // kept card never renders '—'. Pins the two definitions together.
    prismaMock.card.findMany.mockResolvedValue([
      { ...row("nm-only", "Perfect Order", "64", "OP01", null), currentPrices: [{ priceMarket: 12.5 }] },
    ]);
    const body = await (await call("game=onepiece&query=perfect&hasPrice=true")).json();
    const card = body.cards.find((c: { id: string }) => c.id === "nm-only");
    expect(card).toBeDefined();
    expect(card.marketPrice).toBe(12.5);
  });
});

describe("language filter", () => {
  // Language is inferred from the "_ja-" externalId marker (no language column).
  // The underscore MUST be escaped so Postgres LIKE matches it literally — the
  // JS string "\\_ja-" is the two chars `\` + `_`. These literals pin the escape
  // so a regression to an unescaped "_ja-" (which also matches "Xja-") fails.
  // The language predicate is nested in its OWN `AND` clause (so its top-level
  // NOT can't clobber the sibling graded `NOT`/`OR`), alongside any other
  // AND clauses (hasPrice, the relevance query OR). Assert it's present IN the
  // AND array, not as a top-level `externalId`/`NOT` key.
  const JA_CLAUSE = { externalId: { contains: "\\_ja-" } };
  const NOT_JA_CLAUSE = { NOT: { externalId: { contains: "\\_ja-" } } };
  const andOf = (w: Record<string, unknown>) =>
    (w.AND as Array<Record<string, unknown>> | undefined) ?? [];

  it("language=ja adds the escaped `contains '_ja-'` predicate to every query", async () => {
    prismaMock.card.findMany.mockResolvedValue([row("x-1", "Raichu")]); // no name hit → stage 2 runs
    await call("game=pokemon&query=charzard&language=ja");
    const ws = wheres();
    expect(ws.length).toBeGreaterThanOrEqual(2); // stage 1 + stage 2 recall
    for (const w of ws) {
      expect(andOf(w)).toEqual(expect.arrayContaining([JA_CLAUSE]));
      // Escaped underscore: NOT the unescaped "_ja-" that would match "Xja-".
      expect(JSON.stringify(w)).not.toContain('"contains":"_ja-"');
    }
  });

  it("language=en adds the negated predicate to every query", async () => {
    prismaMock.card.findMany.mockResolvedValue([row("x-1", "Raichu")]); // stage 2 recall too
    await call("game=pokemon&query=charzard&language=en");
    const ws = wheres();
    expect(ws.length).toBeGreaterThanOrEqual(2);
    for (const w of ws) expect(andOf(w)).toEqual(expect.arrayContaining([NOT_JA_CLAUSE]));
  });

  it("graded=ungraded & language=en keep BOTH filters (no NOT-key collision)", async () => {
    // Regression guard: both branches used to key on a bare top-level `NOT`,
    // so a plain spread let language overwrite the ungraded filter. The
    // language `NOT` now lives inside `AND`, so BOTH must survive together.
    prismaMock.card.findMany.mockResolvedValue([row("x-1", "Raichu")]); // stage 2 recall too
    await call("game=pokemon&query=charzard&graded=ungraded&language=en");
    const ws = wheres();
    expect(ws.length).toBeGreaterThanOrEqual(2);
    for (const w of ws) {
      // ungraded's top-level NOT:{OR} is untouched...
      expect(w.NOT).toBeDefined();
      expect((w.NOT as { OR?: unknown }).OR).toBeDefined();
      // ...and the language NOT:{externalId} rides in the AND array.
      expect(andOf(w)).toEqual(expect.arrayContaining([NOT_JA_CLAUSE]));
    }
  });

  it.each([
    ["language=all", "game=pokemon&query=charzard&language=all"],
    ["omitted", "game=pokemon&query=charzard"],
  ])("%s adds NO language predicate (default path unchanged)", async (_n, qs) => {
    prismaMock.card.findMany.mockResolvedValue([row("x-1", "Raichu")]);
    await call(qs);
    for (const w of wheres()) {
      expect(JSON.stringify(w)).not.toContain("_ja-");
    }
  });

  it("rejects an invalid language value with 400", async () => {
    expect((await call("game=pokemon&query=x&language=fr")).status).toBe(400);
  });
});

describe("image presence filter", () => {
  // Bug 1: imageless catalog rows (null/empty imageUrl) must NEVER appear in
  // search. The two clauses are UNCONDITIONAL (no opt-in param) and live in the
  // nested `AND` so they compose with — never clobber — the graded top-level
  // NOT/OR and the language NOT. Assert via the same andOf() helper the
  // language block uses.
  const IMG_NOT_NULL = { imageUrl: { not: null } };
  const IMG_NOT_EMPTY = { NOT: { imageUrl: "" } };
  const andOf = (w: Record<string, unknown>) =>
    (w.AND as Array<Record<string, unknown>> | undefined) ?? [];

  it("adds the two image clauses to every query, even with no hasPrice/language params", async () => {
    prismaMock.card.findMany.mockResolvedValue([row("x-1", "Raichu")]); // no name hit → stage 2 runs
    await call("game=pokemon&query=charzard");
    const ws = wheres();
    expect(ws.length).toBeGreaterThanOrEqual(2); // stage 1 + stage 2 recall
    for (const w of ws) {
      expect(andOf(w)).toEqual(expect.arrayContaining([IMG_NOT_NULL, IMG_NOT_EMPTY]));
    }
  });

  it("keeps ALL THREE filters when graded=ungraded & language=en (no key collision)", async () => {
    prismaMock.card.findMany.mockResolvedValue([row("x-1", "Raichu")]); // stage 2 recall too
    await call("game=pokemon&query=charzard&graded=ungraded&language=en");
    const ws = wheres();
    expect(ws.length).toBeGreaterThanOrEqual(2);
    for (const w of ws) {
      // graded ungraded's top-level NOT:{OR} is untouched...
      expect(w.NOT).toBeDefined();
      expect((w.NOT as { OR?: unknown }).OR).toBeDefined();
      // ...language NOT:{externalId} rides in the AND...
      expect(andOf(w)).toEqual(
        expect.arrayContaining([{ NOT: { externalId: { contains: "\\_ja-" } } }])
      );
      // ...and the image clauses survive alongside them.
      expect(andOf(w)).toEqual(expect.arrayContaining([IMG_NOT_NULL, IMG_NOT_EMPTY]));
    }
  });
});

describe("Typesense flag", () => {
  it("is never called when disabled (default)", async () => {
    await call("game=pokemon&query=charizard");
    expect(indexMock.searchIndexIds).not.toHaveBeenCalled();
  });

  it("hydrates from Postgres in index order with the same filters", async () => {
    indexMock.isSearchIndexEnabled.mockReturnValue(true);
    indexMock.searchIndexIds.mockResolvedValue(["b-1", "a-1"]);
    prismaMock.card.findMany.mockResolvedValue([row("a-1", "A"), row("b-1", "B")]);
    const body = await (await call("game=pokemon&query=thing&set=Base")).json();
    expect(body.cards.map((c: { id: string }) => c.id)).toEqual(["b-1", "a-1"]);
    const w = wheres()[0];
    expect(w.externalId).toEqual({ in: ["b-1", "a-1"] });
    expect(w.set).toMatchObject({ name: { equals: "Base" } });
  });

  it.each([
    ["returns null", () => indexMock.searchIndexIds.mockResolvedValue(null)],
    ["throws", () => indexMock.searchIndexIds.mockRejectedValue(new Error("down"))],
  ])("falls back to Postgres with 200 when the adapter %s", async (_n, arrange) => {
    indexMock.isSearchIndexEnabled.mockReturnValue(true);
    arrange();
    const res = await call("game=pokemon&query=charizard");
    expect(res.status).toBe(200);
    expect((await res.json()).cards[0].id).toBe("base1-4");
  });
});
