import { describe, it, expect, vi, beforeEach } from "vitest";
import { CACHE_TTL } from "@/lib/redis";

/**
 * Empty-cache poisoning guard for GET /api/cards/[id]/population.
 *
 * A null report means the card hasn't been refreshed yet. Pinning that null for
 * the full 24h TTL would mask a report that lands after first view (a manual
 * refresh best-effort DELs this key, but if that runs on another instance or
 * Redis is briefly unreachable the null blob survives a FULL DAY). So:
 *   - report == null  → do NOT write the cache.
 *   - report present  → cache with the full CACHE_TTL.cardPopulation (24h).
 *
 * Mocks the population service (pure stored read) + the ioredis singleton to a
 * permanent MISS so the test is hermetic (no live DB / Redis).
 */

const populationMock = vi.hoisted(() => ({
  getStoredPopulationReport: vi.fn(),
  BGS_POPULATION_SUPPORTED: false,
}));
vi.mock("@/lib/services/population.service", () => populationMock);

const redisMock = vi.hoisted(() => ({
  get: vi.fn(async () => null),
  set: vi.fn(async () => "OK"),
  del: vi.fn(async () => 0),
  keys: vi.fn(async () => []),
}));
vi.mock("@/lib/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/redis")>();
  return { ...actual, redis: redisMock };
});

import { GET as populationGET } from "@/app/api/cards/[id]/population/route";

const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockResolvedValue("OK");
});

describe("GET /api/cards/[id]/population — empty-cache poisoning guard", () => {
  it("does NOT cache a null report", async () => {
    populationMock.getStoredPopulationReport.mockResolvedValue(null);
    const res = await populationGET(new Request("http://localhost/x"), ctxFor("base1-4"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ report: null, bgsSupported: false });
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it("caches a real report with the full cardPopulation TTL", async () => {
    const report = { source: "scrydex", companies: [], refreshedAt: "2026-01-02T00:00:00.000Z" };
    populationMock.getStoredPopulationReport.mockResolvedValue(report);
    const res = await populationGET(new Request("http://localhost/x"), ctxFor("base1-4"));
    expect(res.status).toBe(200);
    expect(redisMock.set).toHaveBeenCalledTimes(1);
    // ioredis signature: set(key, value, "EX", ttlSeconds)
    expect(redisMock.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "EX",
      CACHE_TTL.cardPopulation
    );
  });
});
