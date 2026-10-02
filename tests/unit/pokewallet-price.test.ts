import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * FR-1 (AC-2/3) — PokéWallet / BerryWallet price client (PRICING ONLY).
 *
 * MOCKS `fetch` so the suite never touches the live api.pokewallet.io (no
 * key, no rate limit, deterministic). Pins:
 *   - pickOnePiecePrice: numeric market for a normal card; null (no throw)
 *     for a CM-only `tcgplayer: null` card (AC-2 — never fabricate, never
 *     throw to the sync engine).
 *   - fetchOnePieceSetPrices: maps a mocked /op/sets body to a Map keyed by
 *     card_number.
 *   - fetchPokemonCardPrice: reads a price from a mocked /search body and
 *     returns null on empty results (AC-3 gap-fill fallback).
 */

import {
  pickOnePiecePrice,
  fetchOnePieceSetPrices,
  fetchPokemonCardPrice,
} from "@/lib/services/pokewallet.service";

function mockFetchOnce(impl: () => Promise<Partial<Response>> | Partial<Response>) {
  const fn = vi.fn(async (_url: string, _opts?: RequestInit) => impl() as unknown as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  process.env.POKEWALLET_API_KEY = "pk_test_123";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pickOnePiecePrice (pure)", () => {
  it("returns the numeric TCGplayer market price for a normal card", () => {
    const price = pickOnePiecePrice({
      id: "op01-001",
      card_number: "OP01-001",
      tcgplayer: { prices: { low_price: 3.5, market_price: 5.25, high_price: 9 } },
      cardmarket: null,
    } as never);
    expect(price.market).toBe(5.25);
    expect(price.low).toBe(3.5);
    expect(price.currency).toBe("USD");
  });

  it("falls back to Cardmarket when TCGplayer is absent", () => {
    const price = pickOnePiecePrice({
      id: "op01-002",
      card_number: "OP01-002",
      tcgplayer: null,
      cardmarket: { prices: { avg: 2.1, low: 1.4, trend: 2 } },
    } as never);
    expect(price.market).toBe(2.1);
    expect(price.low).toBe(1.4);
  });

  it("returns null (NO throw) for a CM-only `tcgplayer: null` card with no cardmarket price", () => {
    const price = pickOnePiecePrice({
      id: "op01-003",
      card_number: "OP01-003",
      tcgplayer: null,
      cardmarket: null,
    } as never);
    expect(price.market).toBeNull();
    expect(price.low).toBeNull();
  });

  it("keeps bogus 0 / non-finite values out (num guard)", () => {
    const price = pickOnePiecePrice({
      id: "op01-004",
      card_number: "OP01-004",
      tcgplayer: { prices: { low_price: 0, market_price: 0 } },
      cardmarket: null,
    } as never);
    expect(price.market).toBeNull();
    expect(price.low).toBeNull();
  });
});

describe("fetchOnePieceSetPrices", () => {
  it("maps a mocked /op/sets body to a Map keyed by card_number", async () => {
    const fn = mockFetchOnce(() => ({
      ok: true,
      json: async () => ({
        success: true,
        set: { set_code: "OP01" },
        data: [
          {
            id: "op01-001",
            card_number: "OP01-001",
            tcgplayer: { prices: { market_price: 5.25, low_price: 3.5 } },
            cardmarket: null,
          },
          {
            id: "op01-002",
            card_number: "OP01-002",
            tcgplayer: null,
            cardmarket: { prices: { avg: 2.1, low: 1.4 } },
          },
        ],
      }),
    }));

    const map = await fetchOnePieceSetPrices("OP01");

    // The endpoint + key header are the verified live contract.
    const [url, opts] = fn.mock.calls[0];
    expect(url).toContain("/op/sets/OP01");
    expect(((opts?.headers ?? {}) as Record<string, string>)["X-API-Key"]).toBe("pk_test_123");

    expect(map.size).toBe(2);
    expect(map.get("OP01-001")?.market).toBe(5.25);
    expect(map.get("OP01-002")?.market).toBe(2.1);
  });

  it("returns an empty Map (never throws) on a non-OK response", async () => {
    mockFetchOnce(() => ({ ok: false, status: 500, json: async () => ({}) }));
    const map = await fetchOnePieceSetPrices("OP99");
    expect(map.size).toBe(0);
  });

  it("returns an empty Map on a parse failure", async () => {
    mockFetchOnce(() => ({ ok: true, json: async () => ({ unexpected: true }) }));
    const map = await fetchOnePieceSetPrices("OP01");
    expect(map.size).toBe(0);
  });
});

describe("fetchPokemonCardPrice (gap-fill by name)", () => {
  it("reads a price from a mocked /search body", async () => {
    const fn = mockFetchOnce(() => ({
      ok: true,
      json: async () => ({
        data: [
          {
            tcgplayer: { prices: { market_price: 42.5, low_price: 30 } },
            cardmarket: null,
          },
        ],
      }),
    }));

    const price = await fetchPokemonCardPrice("Charizard");
    expect(fn.mock.calls[0][0]).toContain("/search?q=Charizard");
    expect(price?.market).toBe(42.5);
    expect(price?.low).toBe(30);
  });

  it("returns null on empty search results", async () => {
    mockFetchOnce(() => ({ ok: true, json: async () => ({ data: [] }) }));
    await expect(fetchPokemonCardPrice("Nonexistent")).resolves.toBeNull();
  });

  it("returns null (never throws) on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(fetchPokemonCardPrice("Charizard")).resolves.toBeNull();
  });
});
