import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * F-17 — PSA Public API integration (graded pricing).
 *
 * These tests MOCK `fetch` so CI never touches the real PSA API — no rate
 * limits, no token required, deterministic results. They pin:
 *   - a successful cert verification → a derived graded value
 *   - graceful `null` on 429 rate-limit, network error, invalid cert, and
 *     missing API key
 *   - the fallback contract: when the live PSA source returns null,
 *     `resolveGradedPrice` still yields a value and flags it isFallback.
 */

import { fetchPSACert, fetchPSAGradedPrice } from "@/lib/services/psa-price.service";
import { resolveGradedPrice } from "@/lib/utils/graded-price";

const API_KEY = "test-psa-token";

// A realistic PSA cert payload (Charizard Base Set PSA 10), shaped like the
// real /cert/GetByCertNumber response.
const okCert = {
  IsValidRequest: true,
  ServerMessage: "Request successful",
  PSACert: {
    CertNumber: 12345678,
    CardGrade: "10",
    Subject: "Charizard",
    Variety: "Base Set",
    YearIssued: "1999",
  },
};

function mockFetchOnce(impl: () => Promise<Partial<Response>> | Partial<Response>) {
  const fn = vi.fn(async (_url: string, _opts?: RequestInit) => impl() as unknown as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  process.env.PSA_API_KEY = API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchPSACert — live verification (mocked)", () => {
  it("returns the parsed cert and sends a bearer auth header to the PSA endpoint", async () => {
    const fn = mockFetchOnce(() => ({
      ok: true,
      json: async () => okCert,
    }));

    const cert = await fetchPSACert("12345678");

    expect(cert).toEqual({
      certNumber: 12345678,
      grade: "10",
      subject: "Charizard",
      set: "Base Set",
      year: "1999",
    });
    // Hit the documented public API endpoint with a bearer token.
    const [url, opts] = fn.mock.calls[0];
    expect(url).toContain("api.psacard.com/publicapi/cert/GetByCertNumber/12345678");
    expect(((opts?.headers ?? {}) as Record<string, string>).Authorization).toBe(`bearer ${API_KEY}`);
  });

  it("returns null on a 429 rate-limit response (never throws)", async () => {
    mockFetchOnce(() => ({ ok: false, status: 429, json: async () => ({}) }));
    await expect(fetchPSACert("12345678")).resolves.toBeNull();
  });

  it("returns null when the network call throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(fetchPSACert("12345678")).resolves.toBeNull();
  });

  it("returns null for an invalid/unknown cert (IsValidRequest false)", async () => {
    mockFetchOnce(() => ({
      ok: true,
      json: async () => ({ IsValidRequest: false, ServerMessage: "Invalid CertNo", PSACert: null }),
    }));
    await expect(fetchPSACert("00000000")).resolves.toBeNull();
  });

  it("returns null when no API key is configured (no network call made)", async () => {
    delete process.env.PSA_API_KEY;
    const fn = mockFetchOnce(() => ({ ok: true, json: async () => okCert }));
    await expect(fetchPSACert("12345678")).resolves.toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it("does not call the API for a non-numeric cert number", async () => {
    const fn = mockFetchOnce(() => ({ ok: true, json: async () => okCert }));
    await expect(fetchPSACert("abc")).resolves.toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("fetchPSAGradedPrice — verified-grade → derived value", () => {
  it("verifies the cert then returns the curated graded value for that grade", async () => {
    mockFetchOnce(() => ({ ok: true, json: async () => okCert }));

    const price = await fetchPSAGradedPrice({
      cardName: "Charizard",
      set: "Base Set",
      grade: 10,
      rawMarketPrice: 3500,
      certNumber: "12345678",
    });

    // Curated Charizard Base Set PSA 10 = $35,000 (see graded-price.ts).
    expect(price).toBe(35000);
  });

  it("returns null when verification fails (rate-limited) so the caller can fall back", async () => {
    mockFetchOnce(() => ({ ok: false, status: 429, json: async () => ({}) }));
    const price = await fetchPSAGradedPrice({
      cardName: "Charizard",
      set: "Base Set",
      grade: 10,
      rawMarketPrice: 3500,
      certNumber: "12345678",
    });
    expect(price).toBeNull();
  });

  it("returns null when no cert is supplied (no live signal)", async () => {
    const price = await fetchPSAGradedPrice({
      cardName: "Charizard",
      set: "Base Set",
      grade: 10,
      rawMarketPrice: 3500,
    });
    expect(price).toBeNull();
  });
});

describe("resolveGradedPrice ⇄ PSA source fallback", () => {
  it("uses the live PSA-derived value when verification succeeds", async () => {
    mockFetchOnce(() => ({ ok: true, json: async () => okCert }));
    const live = await fetchPSAGradedPrice({
      cardName: "Charizard", set: "Base Set", grade: 10, rawMarketPrice: 3500, certNumber: "12345678",
    });
    const res = resolveGradedPrice({
      cardName: "Charizard",
      setName: "Base Set",
      grade: 10,
      rawMarketPrice: 3500,
      priceSource: () => live,
    });
    expect(res.price).toBe(35000);
    expect(res.isFallback).toBe(false);
  });

  it("falls back (isFallback true) and never throws when PSA is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("PSA down"); }));
    const live = await fetchPSAGradedPrice({
      cardName: "Charizard", set: "Base Set", grade: 10, rawMarketPrice: 3500, certNumber: "12345678",
    });
    expect(live).toBeNull();
    const res = resolveGradedPrice({
      cardName: "Charizard",
      setName: "Base Set",
      grade: 10,
      rawMarketPrice: 3500,
      priceSource: () => live, // null → resolver uses its curated fallback
    });
    expect(res.isFallback).toBe(true);
    expect(res.price).toBeGreaterThan(0);
  });
});
