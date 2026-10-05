import { describe, it, expect, vi, beforeEach } from "vitest";
import { CACHE_TTL } from "@/lib/redis";

/**
 * NFR-2 / NFR-4 — null-safe history + graceful public card routes.
 *
 * Pins the §7.1 route edits so a future "import unchanged" regression is
 * caught:
 *   - GET /api/cards/[id]/history drops rows with priceMarket == null (no
 *     fabricated 0 point) and returns {points:[]}+200 for an unknown card.
 *   - GET /api/cards/[id]/prices returns {prices:[]}+200 (NOT 404/500) for
 *     unknown-card and error branches.
 *   - GET /api/users/me/collection/history skips null-priced rows so a card
 *     with no priced history contributes 0 only by absence (not a fabricated
 *     0 drag).
 *
 * Mocks Prisma (+ the auth guard for the authed collection route). No live DB.
 */

const prismaMock = vi.hoisted(() => ({
  card: { findUnique: vi.fn() },
  pricingHistory: { findMany: vi.fn() },
  userCollection: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

// The card-detail history/prices routes now go through the fail-open Redis
// cache. Mock the ioredis singleton to a permanent MISS so these tests stay
// hermetic (no live Redis) and each assertion exercises the live Prisma path.
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

const USER_ID = "user_123";
vi.mock("@/lib/utils/auth-guard", () => ({
  requireAuth: vi.fn(async () => ({ unauthorized: null, session: { user: { id: USER_ID } } })),
}));

import { GET as historyGET } from "@/app/api/cards/[id]/history/route";
import { GET as pricesGET } from "@/app/api/cards/[id]/prices/route";
import { GET as collectionHistoryGET } from "@/app/api/users/me/collection/history/route";

const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  // Keep the cache a permanent MISS after clearAllMocks wipes implementations.
  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockResolvedValue("OK");
  redisMock.del.mockResolvedValue(0);
  redisMock.keys.mockResolvedValue([]);
});

// --- /api/cards/[id]/history ----------------------------------------------

describe("GET /api/cards/[id]/history (NFR-2 / NFR-4)", () => {
  it("partitions raw vs graded, drops null-price rows, keeps oldest→newest", async () => {
    prismaMock.card.findUnique.mockResolvedValue({ id: "card_1" });
    prismaMock.pricingHistory.findMany.mockResolvedValue([
      { priceMarket: 10, recordedAt: new Date("2026-01-01"), type: "raw", company: null, grade: null },
      { priceMarket: null, recordedAt: new Date("2026-01-02"), type: "raw", company: null, grade: null }, // dropped
      { priceMarket: 12, recordedAt: new Date("2026-01-03"), type: "raw", company: null, grade: null },
      // a graded PSA 10 point lands under graded["PSA|10"]
      { priceMarket: 900, recordedAt: new Date("2026-01-03"), type: "graded", company: "PSA", grade: "10" },
    ]);

    const res = await historyGET(new Request("http://localhost/x"), ctxFor("base1-4"));
    const body = await res.json();

    expect(res.status).toBe(200);
    // raw: null-price row dropped, oldest→newest preserved.
    expect(body.raw).toHaveLength(2);
    expect(body.raw.map((p: { price: number }) => p.price)).toEqual([10, 12]);
    // graded keyed by `${company}|${grade}`.
    expect(body.graded["PSA|10"]).toHaveLength(1);
    expect(body.graded["PSA|10"][0].price).toBe(900);
  });

  it("returns { raw: [], graded: {} } + 200 for an unknown card", async () => {
    prismaMock.card.findUnique.mockResolvedValue(null);
    const res = await historyGET(new Request("http://localhost/x"), ctxFor("nope"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ raw: [], graded: {} });
  });

  // Empty-cache poisoning guard: an unknown card's empty result must NOT be
  // pinned (the enrich pulls history AFTER first view, often on another
  // instance where the best-effort cache DEL can't reach this entry).
  it("does NOT cache the empty result for an unknown card", async () => {
    prismaMock.card.findUnique.mockResolvedValue(null);
    await historyGET(new Request("http://localhost/x"), ctxFor("nope"));
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  // Empty-cache poisoning guard: a known card with 0 real history points is a
  // transient pre-enrich state — don't pin it for the full TTL.
  it("does NOT cache an empty series for a known card with 0 rows", async () => {
    prismaMock.card.findUnique.mockResolvedValue({ id: "card_1" });
    prismaMock.pricingHistory.findMany.mockResolvedValue([]);
    await historyGET(new Request("http://localhost/x"), ctxFor("base1-4"));
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  // A NON-empty series keeps the normal full cardHistory TTL.
  it("caches a non-empty series with the full cardHistory TTL", async () => {
    prismaMock.card.findUnique.mockResolvedValue({ id: "card_1" });
    prismaMock.pricingHistory.findMany.mockResolvedValue([
      { priceMarket: 10, recordedAt: new Date("2026-01-01"), type: "raw", company: null, grade: null },
    ]);
    await historyGET(new Request("http://localhost/x"), ctxFor("base1-4"));
    expect(redisMock.set).toHaveBeenCalledTimes(1);
    // ioredis signature: set(key, value, "EX", ttlSeconds)
    expect(redisMock.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "EX",
      CACHE_TTL.cardHistory
    );
  });

  it("returns { raw: [], graded: {} } + 200 when the DB throws", async () => {
    prismaMock.card.findUnique.mockRejectedValue(new Error("db down"));
    const res = await historyGET(new Request("http://localhost/x"), ctxFor("base1-4"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ raw: [], graded: {} });
  });
});

// --- /api/cards/[id]/prices -----------------------------------------------

describe("GET /api/cards/[id]/prices (NFR-4)", () => {
  it("returns {prices:[]} + 200 for an unknown card (not 404)", async () => {
    prismaMock.card.findUnique.mockResolvedValue(null);
    const res = await pricesGET(new Request("http://localhost/x"), ctxFor("nope"));
    expect(res.status).toBe(200);
    expect((await res.json()).prices).toEqual([]);
  });

  it("returns {prices:[]} + 200 when the DB throws (not 500)", async () => {
    prismaMock.card.findUnique.mockRejectedValue(new Error("db down"));
    const res = await pricesGET(new Request("http://localhost/x"), ctxFor("base1-4"));
    expect(res.status).toBe(200);
    expect((await res.json()).prices).toEqual([]);
  });

  it("returns the card's current prices for a known card", async () => {
    prismaMock.card.findUnique.mockResolvedValue({
      id: "card_1",
      currentPrices: [{ priceMarket: 191.34, source: "SCRYDEX" }],
    });
    const res = await pricesGET(new Request("http://localhost/x"), ctxFor("base1-4"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.prices).toHaveLength(1);
  });
});

// --- /api/users/me/collection/history -------------------------------------

describe("GET /api/users/me/collection/history (NFR-2)", () => {
  it("never fabricates a value: null-priced rows + pre-ownership days are gaps, not $0", async () => {
    // One card held (qty 2), added recently. The endpoint builds a daily
    // timeline over the range and values the lot ONLY within [addedAt, soldAt)
    // using the nearest real price. A null-priced row must not seed a value;
    // days before a real price (or before ownership) are null gaps, never $0.
    const addedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000); // owned 3 days
    prismaMock.userCollection.findMany.mockResolvedValue([
      { cardId: "card_1", quantity: 2, addedAt, soldAt: null, isSold: false },
    ]);
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    prismaMock.pricingHistory.findMany.mockResolvedValue([
      { cardId: "card_1", recordedAt: addedAt, priceMarket: null }, // skipped — no value seeded
      { cardId: "card_1", recordedAt: recent, priceMarket: 10 }, // real → 10 * qty 2 = 20
    ]);

    const res = await collectionHistoryGET(
      new Request("http://localhost/api/users/me/collection/history?range=1M")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    const series: { date: string; value: number | null }[] = body.histories["null"];
    // No point ever carries a fabricated 0: every non-null value is the real
    // carry-forward (20). Null gaps are allowed (pre-price / pre-ownership).
    const values = series.map((p) => p.value);
    expect(values.some((v) => v === 0)).toBe(false); // never a fabricated $0
    expect(values).toContain(20); // the real priced day values the lot (10 × qty 2)
    expect(values.filter((v) => v === 20).length).toBeGreaterThanOrEqual(1);
  });

  it("returns an empty series for a collection with no items", async () => {
    prismaMock.userCollection.findMany.mockResolvedValue([]);
    const res = await collectionHistoryGET(
      new Request("http://localhost/api/users/me/collection/history")
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.histories["null"]).toEqual([]);
  });
});
