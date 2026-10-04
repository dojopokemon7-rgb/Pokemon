import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Game } from "@prisma/client";

/**
 * FR-2 (AC-4/5/6) — Scrydex client price accessors + resolution.
 *
 * All over a MOCKED `fetch`, no live call (Cloudflare + credit cost forbid
 * live calls in the suite). Fixture shapes mirror the verified contract in
 * `.agents/tasks/api-integration-contracts.md` (variants[].prices[] with a
 * type:"raw" entry carrying trends.days_{1,7,14}.price_change, plus graded
 * PSA entries with type!="raw", company:"PSA", grade:"10").
 *
 * Pins:
 *   - pickRawPrice: market/low from the type:"raw" entry; null when absent;
 *     variant/condition verbatim with "normal"/"NM" defaults (finding #8 —
 *     NOT "Normal"/"Near Mint").
 *   - pickGradedPrice: the type!="raw", PSA, grade-matching entry; null else.
 *   - scrydexHeaders: throws without SCRYDEX_TEAM_ID (documents the live-401).
 *   - gameSlug via resolveScrydexCard's request URL: pokemon / onepiece.
 *   - resolveScrydexCard: matches on number (normalizing "4/102"->"4",
 *     stripping leading zeros) + set; null on no match; name+number single
 *     fallback.
 */

import {
  pickRawPrice,
  pickGradedPrice,
  resolveScrydexCard,
  fetchScrydexCardById,
  fetchScrydexPopulation,
  type ScrydexCard,
} from "@/lib/services/scrydex.service";

function mockFetchOnce(impl: () => Promise<Partial<Response>> | Partial<Response>) {
  const fn = vi.fn(async (_url: string, _opts?: RequestInit) => impl() as unknown as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

// A raw entry shaped exactly like the verified contract (trends are absolute
// USD deltas).
const rawEntry = {
  condition: "NM",
  grade: null,
  company: null,
  type: "raw",
  low: 170.0,
  market: 191.34,
  currency: "USD",
  trends: {
    days_1: { price_change: -7.33, percent_change: -3.69 },
    days_7: { price_change: 7.39, percent_change: 4.02 },
    days_14: { price_change: 23.85, percent_change: 14.24 },
  },
};

const psa10Entry = {
  condition: null,
  grade: "10",
  company: "PSA",
  type: "graded",
  low: 300,
  market: 420.5,
  currency: "USD",
};

function cardWith(prices: unknown[], variantName = "holofoil"): ScrydexCard {
  return {
    id: "me55c-4",
    name: "Charizard",
    number: "4",
    printed_number: "4/102",
    expansion: { id: "me55c", name: "Base Set", code: "30C" },
    variants: [{ name: variantName, prices: prices as never }],
  } as ScrydexCard;
}

beforeEach(() => {
  process.env.SCRYDEX_API_KEY = "sk_test_123";
  process.env.SCRYDEX_TEAM_ID = "dojo";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pickRawPrice", () => {
  it("returns market/low from the type:'raw' entry, verbatim variant/condition", () => {
    const raw = pickRawPrice(cardWith([psa10Entry, rawEntry]));
    expect(raw?.market).toBe(191.34);
    expect(raw?.low).toBe(170.0);
    expect(raw?.currency).toBe("USD");
    expect(raw?.variant).toBe("holofoil");
    expect(raw?.condition).toBe("NM");
    expect(raw?.trends?.days_7?.price_change).toBe(7.39);
  });

  it("defaults to 'normal'/'NM' (NOT 'Normal'/'Near Mint') when Scrydex omits them", () => {
    const card = {
      id: "x",
      name: "x",
      number: "1",
      variants: [{ name: undefined as never, prices: [{ type: "raw", market: 10 }] as never }],
    } as unknown as ScrydexCard;
    const raw = pickRawPrice(card);
    expect(raw?.variant).toBe("normal");
    expect(raw?.condition).toBe("NM");
  });

  it("returns null when there is no raw entry (graded-only card)", () => {
    expect(pickRawPrice(cardWith([psa10Entry]))).toBeNull();
  });
});

describe("pickGradedPrice", () => {
  it("returns the type!='raw', PSA, grade-matching entry", () => {
    const graded = pickGradedPrice(cardWith([rawEntry, psa10Entry]), "PSA 10", "PSA");
    expect(graded?.market).toBe(420.5);
    expect(graded?.grade).toBe("10");
    expect(graded?.company).toBe("PSA");
  });

  it("returns null when no entry matches the requested grade", () => {
    expect(pickGradedPrice(cardWith([rawEntry, psa10Entry]), 9, "PSA")).toBeNull();
  });

  it("returns null when the company does not match", () => {
    expect(pickGradedPrice(cardWith([rawEntry, psa10Entry]), 10, "CGC")).toBeNull();
  });
});

describe("scrydexHeaders / auth (AC-4)", () => {
  it("throws when SCRYDEX_TEAM_ID is missing (documents the live 401)", async () => {
    delete process.env.SCRYDEX_TEAM_ID;
    const fn = mockFetchOnce(() => ({ ok: true, json: async () => ({ data: [] }) }));
    // The header build throws synchronously inside the try; resolveScrydexCard
    // swallows it and returns null WITHOUT making the request.
    await expect(
      resolveScrydexCard({ name: "Charizard", number: "4", game: Game.POKEMON })
    ).resolves.toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it("sends BOTH X-Api-Key and X-Team-ID on every request", async () => {
    const fn = mockFetchOnce(() => ({ ok: true, json: async () => ({ data: [] }) }));
    await resolveScrydexCard({ name: "Charizard", number: "4", game: Game.POKEMON });
    const headers = (fn.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
    expect(headers["X-Api-Key"]).toBe("sk_test_123");
    expect(headers["X-Team-ID"]).toBe("dojo");
  });
});

describe("gameSlug (via request URL)", () => {
  it("uses /pokemon/ for POKEMON and /onepiece/ for ONE_PIECE", async () => {
    const fn = mockFetchOnce(() => ({ ok: true, json: async () => ({ data: [] }) }));
    await resolveScrydexCard({ name: "Charizard", number: "4", game: Game.POKEMON });
    expect(fn.mock.calls[0][0]).toContain("/pokemon/v1/cards");
    expect(fn.mock.calls[0][0]).toContain("include=prices");

    await resolveScrydexCard({ name: "Luffy", number: "1", game: Game.ONE_PIECE });
    expect(fn.mock.calls[1][0]).toContain("/onepiece/v1/cards");
  });
});

describe("resolveScrydexCard matching", () => {
  const searchBody = (entries: unknown[]) => ({
    ok: true,
    json: async () => ({ data: entries, total_count: entries.length }),
  });

  it("picks the entry whose number + set match (normalizing '4/102'->'4')", async () => {
    mockFetchOnce(() =>
      searchBody([
        { id: "wrong-set", name: "Charizard", number: "4", expansion: { name: "Jungle" }, variants: [] },
        { id: "right", name: "Charizard", number: "4", expansion: { name: "Base Set" }, variants: [] },
      ])
    );
    const res = await resolveScrydexCard({
      name: "Charizard",
      number: "4/102",
      setName: "Base Set",
      game: Game.POKEMON,
    });
    expect(res?.scrydexId).toBe("right");
  });

  it("strips leading zeros when matching the collector number", async () => {
    mockFetchOnce(() =>
      searchBody([{ id: "zeros", name: "Pikachu", number: "007", expansion: { name: "Base Set" }, variants: [] }])
    );
    const res = await resolveScrydexCard({
      name: "Pikachu",
      number: "7",
      setName: "Base Set",
      game: Game.POKEMON,
    });
    expect(res?.scrydexId).toBe("zeros");
  });

  it("returns null when no number+set match exists", async () => {
    mockFetchOnce(() =>
      searchBody([{ id: "a", name: "Charizard", number: "99", expansion: { name: "Jungle" }, variants: [] }])
    );
    const res = await resolveScrydexCard({
      name: "Charizard",
      number: "4",
      setName: "Base Set",
      game: Game.POKEMON,
    });
    expect(res).toBeNull();
  });

  it("falls back to a single name+number match when the set wording differs", async () => {
    mockFetchOnce(() =>
      searchBody([{ id: "only", name: "Charizard", number: "4", expansion: { name: "Base" }, variants: [] }])
    );
    // setName "Base Set" !== "Base", but the number is unique → single-match fallback.
    const res = await resolveScrydexCard({
      name: "Charizard",
      number: "4",
      setName: "Base Set",
      game: Game.POKEMON,
    });
    expect(res?.scrydexId).toBe("only");
  });
});

describe("fetchScrydexCardById", () => {
  it("fetches by native id and returns the parsed card", async () => {
    const fn = mockFetchOnce(() => ({
      ok: true,
      json: async () => ({ data: cardWith([rawEntry]) }),
    }));
    const card = await fetchScrydexCardById("me55c-4", Game.POKEMON);
    expect(fn.mock.calls[0][0]).toContain("/pokemon/v1/cards/me55c-4");
    expect(card?.id).toBe("me55c-4");
  });

  it("returns null (never throws) on a non-OK response", async () => {
    mockFetchOnce(() => ({ ok: false, status: 404, json: async () => ({}) }));
    await expect(fetchScrydexCardById("missing", Game.POKEMON)).resolves.toBeNull();
  });
});

describe("fetchScrydexPopulation (variants[].pop_reports path fix)", () => {
  const popBody = (variants: unknown[]) => ({
    ok: true,
    json: async () => ({ data: { variants } }),
  });

  it("extracts PSA English grades nested under data.variants[].pop_reports", async () => {
    const fn = mockFetchOnce(() =>
      popBody([
        {
          name: "holofoil",
          pop_reports: [
            { company: "PSA", grade: "10", count: 123 },
            { company: "PSA", grade: "9", count: 45 },
          ],
        },
      ])
    );
    const pop = await fetchScrydexPopulation("me55c-4", Game.POKEMON);
    expect(fn.mock.calls[0][0]).toContain("/pokemon/v1/cards/me55c-4?include=pop_reports");
    expect(pop).toEqual({
      company: "PSA",
      language: "English",
      total: 168, // summed (no declared entry.total)
      grades: [
        { grade: "10", count: 123 },
        { grade: "9", count: 45 },
      ],
    });
  });

  it("returns null (honest empty) when variants[].pop_reports is empty", async () => {
    mockFetchOnce(() => popBody([{ name: "holofoil", pop_reports: [] }]));
    await expect(fetchScrydexPopulation("me55c-4", Game.POKEMON)).resolves.toBeNull();
  });

  it("excludes BGS entries and never fabricates them", async () => {
    const pop = await (async () => {
      mockFetchOnce(() =>
        popBody([
          {
            pop_reports: [
              { company: "PSA", grade: "10", count: 10 },
              { company: "BGS", grade: "9.5", count: 999 },
            ],
          },
        ])
      );
      return fetchScrydexPopulation("me55c-4", Game.POKEMON);
    })();
    expect(pop).toEqual({
      company: "PSA",
      language: "English",
      total: 10,
      grades: [{ grade: "10", count: 10 }],
    });
  });

  it("supports the nested grades[] entry shape with a declared total", async () => {
    mockFetchOnce(() =>
      popBody([
        {
          pop_reports: [
            {
              company: "PSA",
              language: "English",
              total: 2000,
              grades: [
                { grade: "10", count: 1200 },
                { grade: "9", count: 800 },
              ],
            },
          ],
        },
      ])
    );
    const pop = await fetchScrydexPopulation("me55c-4", Game.POKEMON);
    expect(pop).toEqual({
      company: "PSA",
      language: "English",
      total: 2000,
      grades: [
        { grade: "10", count: 1200 },
        { grade: "9", count: 800 },
      ],
    });
  });

  it("aggregates PSA grades across multiple variants, summing repeats", async () => {
    mockFetchOnce(() =>
      popBody([
        { name: "normal", pop_reports: [{ company: "PSA", grade: "10", count: 5 }] },
        { name: "holofoil", pop_reports: [{ company: "psa", grade: "10", count: 3 }] },
      ])
    );
    const pop = await fetchScrydexPopulation("me55c-4", Game.POKEMON);
    expect(pop).toEqual({
      company: "PSA",
      language: "English",
      total: 8,
      grades: [{ grade: "10", count: 8 }],
    });
  });

  it("returns null when the card response has no variants at all", async () => {
    mockFetchOnce(() => popBody([]));
    await expect(fetchScrydexPopulation("me55c-4", Game.POKEMON)).resolves.toBeNull();
  });
});
