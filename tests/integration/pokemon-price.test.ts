import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * F-18 — Pokémon TCG API current-price fetcher (mocked).
 *
 * `fetch` is stubbed so CI never touches the real Pokémon TCG API — no rate
 * limits, no key required, deterministic. Pins: successful market-price
 * extraction (with the X-Api-Key header sent), variant scanning, and
 * graceful `null` on 404 / 429 / network error / missing price block.
 */

import { fetchPokemonMarketPrice } from "@/lib/services/pokemon-price.service";

const API_KEY = "test-pokemon-key";

function mockFetchOnce(impl: () => Partial<Response> | Promise<Partial<Response>>) {
  const fn = vi.fn(async (_url: string, _opts?: RequestInit) => impl() as unknown as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** A realistic /v2/cards/{id} response with a TCGplayer price block. */
const okCard = {
  data: {
    id: "base1-4",
    tcgplayer: {
      prices: {
        holofoil: { low: 200, mid: 240, high: 400, market: 246.0 },
      },
    },
  },
};

beforeEach(() => {
  process.env.POKEMON_TCG_API_KEY = API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchPokemonMarketPrice", () => {
  it("returns the TCGplayer market price and sends the X-Api-Key header", async () => {
    const fn = mockFetchOnce(() => ({ ok: true, json: async () => okCard }));

    const price = await fetchPokemonMarketPrice("base1-4");

    expect(price).not.toBeNull();
    expect(price!.value).toBe(246.0);
    expect(price!.currency).toBe("USD");
    expect(price!.timestamp).toBeInstanceOf(Date);

    const [url, opts] = fn.mock.calls[0];
    expect(url).toContain("api.pokemontcg.io/v2/cards/base1-4");
    expect(((opts?.headers ?? {}) as Record<string, string>)["X-Api-Key"]).toBe(API_KEY);
  });

  it("scans variants and picks the first present market price", async () => {
    mockFetchOnce(() => ({
      ok: true,
      json: async () => ({
        data: {
          tcgplayer: {
            prices: {
              normal: { market: null },
              reverseHolofoil: { market: 12.5 },
            },
          },
        },
      }),
    }));
    const price = await fetchPokemonMarketPrice("base1-58");
    expect(price!.value).toBe(12.5);
  });

  it("returns null when the card has no tcgplayer price block", async () => {
    mockFetchOnce(() => ({ ok: true, json: async () => ({ data: { id: "x", tcgplayer: null } }) }));
    await expect(fetchPokemonMarketPrice("x")).resolves.toBeNull();
  });

  it("returns null on a 404 (unknown id)", async () => {
    mockFetchOnce(() => ({ ok: false, status: 404, json: async () => ({}) }));
    await expect(fetchPokemonMarketPrice("nope-1")).resolves.toBeNull();
  });

  it("returns null on a 429 rate-limit response", async () => {
    mockFetchOnce(() => ({ ok: false, status: 429, json: async () => ({}) }));
    await expect(fetchPokemonMarketPrice("base1-4")).resolves.toBeNull();
  });

  it("returns null (never throws) when the network call fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(fetchPokemonMarketPrice("base1-4")).resolves.toBeNull();
  });

  it("works without an API key (unauthenticated low-volume access)", async () => {
    delete process.env.POKEMON_TCG_API_KEY;
    const fn = mockFetchOnce(() => ({ ok: true, json: async () => okCard }));
    const price = await fetchPokemonMarketPrice("base1-4");
    expect(price!.value).toBe(246.0);
    // No X-Api-Key header when the key is absent.
    const [, opts] = fn.mock.calls[0];
    expect(((opts?.headers ?? {}) as Record<string, string>)["X-Api-Key"]).toBeUndefined();
  });
});
