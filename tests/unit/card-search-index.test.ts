import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isSearchIndexEnabled, searchIndexIds } from "@/lib/services/card-search-index.service";

const params = { game: "pokemon" as const, query: "charizard" };
const okBody = (ids: string[]) => ({
  ok: true,
  json: async () => ({ hits: ids.map((externalId) => ({ document: { externalId } })) }),
});

beforeEach(() => {
  vi.stubEnv("SEARCH_ENGINE", "typesense");
  vi.stubEnv("TYPESENSE_URL", "http://ts.test:8108");
  vi.stubEnv("TYPESENSE_SEARCH_API_KEY", "search-key-secret");
  vi.stubEnv("TYPESENSE_COLLECTION", "cards");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("card-search-index adapter", () => {
  it("is disabled unless flag, url and key are all set; never fetches then", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    vi.stubEnv("SEARCH_ENGINE", "");
    expect(isSearchIndexEnabled()).toBe(false);
    expect(await searchIndexIds(params)).toBeNull();
    vi.stubEnv("SEARCH_ENGINE", "typesense");
    vi.stubEnv("TYPESENSE_SEARCH_API_KEY", "");
    expect(isSearchIndexEnabled()).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("returns ordered ids and sends key header + filter_by", async () => {
    const f = vi.fn(async () => okBody(["base1-4", "sv3-125"]));
    vi.stubGlobal("fetch", f);
    const ids = await searchIndexIds({ ...params, set: "Base", minPrice: 5, maxPrice: 50 });
    expect(ids).toEqual(["base1-4", "sv3-125"]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.pathname).toBe("/collections/cards/documents/search");
    expect(u.searchParams.get("filter_by")).toBe("game:=pokemon && setName:=`Base` && marketPrice:>=5 && marketPrice:<=50");
    expect((init.headers as Record<string, string>)["X-TYPESENSE-API-KEY"]).toBe("search-key-secret");
    expect(url).not.toContain("search-key-secret");
  });

  it("returns null on malformed hits, non-2xx, and network errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ hits: [{ document: {} }] }) })));
    expect(await searchIndexIds(params)).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    expect(await searchIndexIds(params)).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    expect(await searchIndexIds(params)).toBeNull();
  });

  it("aborts on timeout and returns null", async () => {
    vi.stubEnv("TYPESENSE_TIMEOUT_MS", "20");
    vi.stubGlobal("fetch", vi.fn((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))
    ));
    expect(await searchIndexIds(params)).toBeNull();
  });

  it("never calls the index for identifier-shaped queries", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await searchIndexIds({ ...params, query: "mee-16" })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
