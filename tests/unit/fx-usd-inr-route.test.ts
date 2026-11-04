import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redisGet = vi.fn();
const redisSet = vi.fn();
vi.mock("@/lib/redis", () => ({
  redis: { get: (...a: unknown[]) => redisGet(...a), set: (...a: unknown[]) => redisSet(...a) },
  RedisKeys: { fxRates: (b: string) => `fx:rates:${b}` },
}));

import { GET } from "@/app/api/fx/usd-inr/route";

describe("GET /api/fx/usd-inr", () => {
  beforeEach(() => {
    redisGet.mockReset().mockResolvedValue(null);
    redisSet.mockReset().mockResolvedValue("OK");
    delete process.env.EXCHANGE_RATE_API_KEY;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.EXCHANGE_RATE_API_KEY;
  });

  it("returns 200 { rate:null } and makes NO request when no API key is set", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rate: null, asOf: null });
    expect(f).not.toHaveBeenCalled();
  });

  it("returns the real INR rate from the provider and caches it", async () => {
    process.env.EXCHANGE_RATE_API_KEY = "k";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, timestamp: 1_700_000_000, quotes: { USDINR: 83.25, USDEUR: 0.9 } }),
      })
    );
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.rate).toBe(83.25);
    expect(body.asOf).toBe(new Date(1_700_000_000 * 1000).toISOString());
    expect(redisSet).toHaveBeenCalled();
  });

  it("serves from the Redis cache without calling the provider", async () => {
    redisGet.mockResolvedValue(JSON.stringify({ base: "USD", rates: { INR: 84 }, asOf: "2026-01-01T00:00:00.000Z" }));
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const body = await (await GET()).json();
    expect(body).toEqual({ rate: 84, asOf: "2026-01-01T00:00:00.000Z" });
    expect(f).not.toHaveBeenCalled();
  });

  it("fails open (200, null) on provider error or malformed payload", async () => {
    process.env.EXCHANGE_RATE_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: false, error: {} }) }));
    let res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rate: null, asOf: null });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    res = await GET();
    expect(await res.json()).toEqual({ rate: null, asOf: null });
  });
});
