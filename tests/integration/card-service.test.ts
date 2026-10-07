import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * card.service — multi-source search with redundant fallback (mocked).
 *
 * Pins the HIGH-VALUE behaviours of the data layer's heart without touching
 * a live API, DB, or Scrydex credit: fetch → map → NormalizedCardSchema
 * safeParse → drop-invalid → empty-set-throws-NoResultsError → fallback chain
 * advances. Follows the repo's existing service-test idioms:
 *   - Redis singleton mocked via vi.mock("@/lib/redis", importOriginal) so the
 *     REAL RedisKeys registry stays (card.service calls RedisKeys.cardSearch),
 *     only the `redis` client is faked (see tests/unit/cache.test.ts).
 *   - `fetch` stubbed per test with vi.stubGlobal (see pokemon-price.test.ts).
 *
 * The fallback-executor's circuit breaker reads redis.get(openKey) and treats
 * null as "closed", so a default `redis.get → null` both misses the service
 * cache AND keeps every breaker closed, letting each source actually run.
 *
 * Deliberately NOT covered here (out of scope — would re-test the executor,
 * not the service): the per-task 5s timeout race and the real breaker
 * open/close cycle across requests. Those live in fallback-executor.ts and
 * need fake timers / stateful Redis fixtures; this file is a card.service
 * mapping + fallback unit test.
 */

const redisMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
  del: vi.fn(),
}));
vi.mock("@/lib/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/redis")>();
  return { ...actual, redis: redisMock };
});

import {
  searchCards,
  searchPokemonCards,
  searchOnePieceCards,
} from "@/lib/services/card.service";

/**
 * Stub `fetch` with a queue of responses consumed in call order, so a test
 * can model "first source fails, second succeeds". Each entry becomes a
 * minimal Response (ok/status/json). A missing `json` defaults to `{}`.
 */
type FakeRes = { ok: boolean; status?: number; statusText?: string; json?: () => Promise<unknown> };
function mockFetchSequence(responses: FakeRes[]) {
  let i = 0;
  const fn = vi.fn(async (_url: string, _opts?: RequestInit) => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      statusText: r.statusText ?? "",
      json: r.json ?? (async () => ({})),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const okJson = (payload: unknown): FakeRes => ({ ok: true, status: 200, json: async () => payload });
const httpError = (status: number): FakeRes => ({ ok: false, status });

beforeEach(() => {
  vi.clearAllMocks();
  // Cache miss + all breakers closed → every source runs live.
  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockResolvedValue("OK");
  redisMock.incr.mockResolvedValue(1);
  redisMock.expire.mockResolvedValue(1);
  redisMock.del.mockResolvedValue(1);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// A realistic pokemontcg.io /v2/cards payload with a TCGplayer price block.
const pokemonTcgPayload = {
  data: [
    {
      id: "base1-4",
      name: "Charizard",
      rarity: "Rare Holo",
      hp: "120",
      types: ["Fire"],
      images: { small: "https://img.pokemontcg.io/base1/4.png" },
      set: { name: "Base" },
      tcgplayer: { prices: { holofoil: { low: 200, market: 246 } } },
    },
  ],
};

describe("searchPokemonCards — happy path (fetch → map → normalize)", () => {
  it("returns the first source mapped into NormalizedCards with the TCGplayer market price", async () => {
    const fn = mockFetchSequence([okJson(pokemonTcgPayload)]);

    const res = await searchPokemonCards("charizard");

    expect(res.source).toBe("pokemon-tcg");
    expect(res.cards).toHaveLength(1);
    const card = res.cards[0];
    expect(card.id).toBe("base1-4");
    expect(card.name).toBe("Charizard");
    expect(card.setImage).toBe("Base");
    expect(card.rarity).toBe("Rare Holo");
    expect(card.hp).toBe("120");
    expect(card.types).toEqual(["Fire"]);
    expect(card.imageUrl).toBe("https://img.pokemontcg.io/base1/4.png");
    expect(card.marketPrice).toBe(246); // pins extractTcgplayerMarketPrice
    // First source wins → only the pokemontcg.io URL was hit, exactly once.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(String(fn.mock.calls[0][0])).toContain("api.pokemontcg.io/v2/cards");
  });
});

describe("buildResponse — per-card safeParse drops invalid cards", () => {
  it("keeps the valid card and drops the one that fails NormalizedCardSchema", async () => {
    mockFetchSequence([
      okJson({
        data: [
          {
            id: "base1-4",
            name: "Charizard",
            rarity: "Rare Holo",
            hp: "120",
            types: ["Fire"],
            images: { small: "https://img.pokemontcg.io/base1/4.png" },
            set: { name: "Base" },
          },
          // Invalid: no image → imageUrl becomes "" → fails the url/path refine.
          {
            id: "base1-5",
            name: "Nidoking",
            set: { name: "Base" },
          },
        ],
      }),
    ]);

    const res = await searchPokemonCards("charizard");
    expect(res.source).toBe("pokemon-tcg");
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0].id).toBe("base1-4");
  });
});

describe("fallback chain advances past empty / zero-valid sources", () => {
  it("advances to tcgdex when pokemon-tcg yields zero valid cards (NoResultsError)", async () => {
    mockFetchSequence([
      // pokemon-tcg: every card invalid (no image) → 0 valid → NoResultsError.
      okJson({ data: [{ id: "x", name: "No Image", set: { name: "S" } }] }),
      // tcgdex: one valid card (image base → appended /high.webp).
      okJson([
        {
          id: "swsh1-1",
          name: "Celebi V",
          image: "https://assets.tcgdex.net/en/swsh/swsh1/1",
          set: { name: "Sword & Shield" },
        },
      ]),
    ]);

    const res = await searchPokemonCards("celebi");
    expect(res.source).toBe("tcgdex");
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0].imageUrl).toBe("https://assets.tcgdex.net/en/swsh/swsh1/1/high.webp");
  });

  it("advances past HARD-failing sources (HTTP 500/503) to scrydex", async () => {
    mockFetchSequence([
      httpError(500), // pokemon-tcg throws (fetchJson → HTTP 500)
      httpError(503), // tcgdex throws
      // scrydex: one valid card.
      okJson({
        data: [
          {
            id: "scry-1",
            name: "Pikachu",
            set_name: "Promo",
            rarity: "Promo",
            image_url: "https://scrydex.example/pikachu.png",
          },
        ],
      }),
    ]);

    const res = await searchPokemonCards("pikachu");
    expect(res.source).toBe("scrydex-pokemon");
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0].id).toBe("scry-1");
    // Hard failures recorded against the breaker (incr called), not NoResults.
    expect(redisMock.incr).toHaveBeenCalled();
  });

  it("rejects with the executor's aggregate error when EVERY source fails", async () => {
    mockFetchSequence([httpError(500)]); // every call → 500
    await expect(searchPokemonCards("nope")).rejects.toThrow(/fallback tasks failed/i);
  });
});

describe("searchCards — top-level cache + guard branches", () => {
  it("short-circuits on a cache HIT without hitting the network", async () => {
    redisMock.get.mockResolvedValueOnce(
      JSON.stringify({
        source: "pokemon-tcg",
        cards: [
          {
            id: "base1-4",
            name: "Charizard",
            number: "",
            setImage: "Base",
            rarity: "Rare Holo",
            hp: "120",
            types: ["Fire"],
            imageUrl: "https://img.pokemontcg.io/base1/4.png",
            marketPrice: 246,
          },
        ],
      })
    );
    const fn = mockFetchSequence([okJson(pokemonTcgPayload)]);

    const res = await searchCards("pokemon", "charizard");
    expect(res.source).toBe("pokemon-tcg");
    expect(res.cards).toHaveLength(1);
    expect(fn).not.toHaveBeenCalled(); // cache hit → no live fetch
  });

  it("returns an empty 'none' result for a blank query without touching cache or network", async () => {
    const fn = mockFetchSequence([okJson(pokemonTcgPayload)]);
    const res = await searchCards("pokemon", "   ");
    expect(res).toEqual({ cards: [], source: "none" });
    expect(fn).not.toHaveBeenCalled();
    expect(redisMock.get).not.toHaveBeenCalled();
  });

  it("on a cache MISS runs the live chain and writes the result back", async () => {
    const fn = mockFetchSequence([okJson(pokemonTcgPayload)]);
    const res = await searchCards("pokemon", "charizard");
    expect(res.source).toBe("pokemon-tcg");
    expect(fn).toHaveBeenCalledTimes(1);
    // Best-effort cache write of the resolved payload (24h TTL).
    expect(redisMock.set).toHaveBeenCalled();
  });
});

describe("searchOnePieceCards — apitcg + Cardmarket chain", () => {
  const apitcgPayload = {
    success: true,
    data: [
      // A sealed product that MUST be filtered out.
      { type: "sealed", name: "Booster Box", code: "OP13-BOX" },
      {
        type: "card",
        code: "OP13-007",
        name: "Ace",
        images: [{ large: "https://tcgplayer-cdn.tcgplayer.com/ace.png" }],
        attributes: { Rarity: "SR", Power: "1000", CardType: "Character", Color: "Red" },
        markets: { tcgplayer: { prices: { market: 5 } } },
      },
    ],
  };

  afterEach(() => {
    delete process.env.APITCG_API_KEY;
  });

  it("maps a real apitcg card (pins parseOnePieceAttrs) and drops sealed products", async () => {
    process.env.APITCG_API_KEY = "test-apitcg-key";
    const fn = mockFetchSequence([okJson(apitcgPayload)]);

    const res = await searchOnePieceCards("ace");
    expect(res.source).toBe("apitcg-onepiece");
    expect(res.cards).toHaveLength(1); // sealed filtered out
    const card = res.cards[0];
    expect(card.id).toBe("OP13-007");
    expect(card.rarity).toBe("SR");
    expect(card.hp).toBe("1000"); // Power surfaced as hp
    expect(card.marketPrice).toBe(5);
    expect(card.types).toEqual(expect.arrayContaining(["Character", "Red"]));
    // apitcg sends the x-api-key header.
    const opts = fn.mock.calls[0][1] as RequestInit | undefined;
    expect(((opts?.headers ?? {}) as Record<string, string>)["x-api-key"]).toBe("test-apitcg-key");
  });

  it("falls through to Cardmarket when APITCG_API_KEY is missing (apitcg throws before fetch)", async () => {
    delete process.env.APITCG_API_KEY;
    const fn = mockFetchSequence([
      // Only ONE network response is consumed: Cardmarket. apitcg throws
      // synchronously (no key) so it never calls fetch.
      okJson({
        product: [
          {
            idProduct: 42,
            enName: "Monkey D. Luffy",
            categoryName: "One Piece Card Game",
            image: "//cdn.cardmarket.com/luffy.png",
          },
        ],
      }),
    ]);

    const res = await searchOnePieceCards("luffy");
    expect(res.source).toBe("cardmarket-onepiece");
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0].id).toBe("42");
    expect(res.cards[0].imageUrl).toBe("https://cdn.cardmarket.com/luffy.png");
    // apitcg made no network call; only Cardmarket did.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(String(fn.mock.calls[0][0])).toContain("api.cardmarket.com");
  });
});
