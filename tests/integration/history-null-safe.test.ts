import { describe, it, expect, vi, beforeEach } from "vitest";

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
});

// --- /api/cards/[id]/history ----------------------------------------------

describe("GET /api/cards/[id]/history (NFR-2 / NFR-4)", () => {
  it("drops rows with priceMarket == null (no fabricated 0 point)", async () => {
    prismaMock.card.findUnique.mockResolvedValue({ id: "card_1" });
    prismaMock.pricingHistory.findMany.mockResolvedValue([
      { priceMarket: 10, recordedAt: new Date("2026-01-01") },
      { priceMarket: null, recordedAt: new Date("2026-01-02") }, // must be dropped
      { priceMarket: 12, recordedAt: new Date("2026-01-03") },
    ]);

    const res = await historyGET(new Request("http://localhost/x"), ctxFor("base1-4"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.points).toHaveLength(2);
    expect(body.points.map((p: { price: number }) => p.price)).toEqual([10, 12]);
  });

  it("returns {points:[]} + 200 for an unknown card", async () => {
    prismaMock.card.findUnique.mockResolvedValue(null);
    const res = await historyGET(new Request("http://localhost/x"), ctxFor("nope"));
    expect(res.status).toBe(200);
    expect((await res.json()).points).toEqual([]);
  });

  it("returns {points:[]} + 200 when the DB throws", async () => {
    prismaMock.card.findUnique.mockRejectedValue(new Error("db down"));
    const res = await historyGET(new Request("http://localhost/x"), ctxFor("base1-4"));
    expect(res.status).toBe(200);
    expect((await res.json()).points).toEqual([]);
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
