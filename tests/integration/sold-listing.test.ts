import { describe, it, expect, vi, beforeEach } from "vitest";
import { Game } from "@prisma/client";

/**
 * FEAT-004 (PART D) — persist recent sales (SoldListing). Integration contract
 * pinned against a MOCKED Prisma client + MOCKED Scrydex thin client + MOCKED
 * credit gate + MOCKED fail-open cache helpers. ZERO external calls, ZERO
 * credits, no live DB.
 *
 * Pins:
 *   D2 pullAndStoreSoldListings (single WRITER, credit-gated):
 *     - gate FIRST: throws ScrydexCreditsNotApproved + makes NO fetch when DENY;
 *     - gate approved: upserts each sold_at-bearing record on [cardId,itemId]
 *       idempotently (a repeat pull issues updates, never duplicate inserts);
 *     - best-effort redis.del of the NEW soldRows key after a store.
 *   D3 GET /api/cards/[id]/ebay-sold (pure Postgres READ, NO gate):
 *     - reads SoldListing from Postgres (NOT a live fetch), ordered soldAt desc
 *       nulls-last, limited 8, WITHOUT calling the credit gate;
 *     - empty -> { listings: [] }, always HTTP 200;
 *     - uses the NEW soldRows key (short TTL), NOT the legacy ebaySold key.
 */

// --- Shared mocks -----------------------------------------------------------

const prismaMock = vi.hoisted(() => ({
  card: { findFirst: vi.fn(), update: vi.fn() },
  soldListing: { upsert: vi.fn(), findMany: vi.fn() },
  syncLog: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

// Scrydex thin client — mocked so NO real network/credits happen.
const scrydexMock = vi.hoisted(() => ({
  fetchScrydexSoldListings: vi.fn(),
  resolveScrydexCard: vi.fn(),
  // referenced by scrydex-pricing.service imports (unused here)
  fetchScrydexCardById: vi.fn(),
  fetchScrydexPriceHistory: vi.fn(),
  fetchScrydexPopulation: vi.fn(),
  pickRawPrice: vi.fn(),
}));
vi.mock("@/lib/services/scrydex.service", () => scrydexMock);

// Credit gate — toggled per test. Real ScrydexCreditsNotApproved is re-exported
// so the thrown instance matches what callers catch.
const gateMock = vi.hoisted(() => ({ approved: false }));
vi.mock("@/lib/services/scrydex-credit-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/scrydex-credit-gate")>();
  return {
    ...actual,
    assertScrydexCreditsApproved: vi.fn(async (op: ScrydexOp, count = 1) => {
      if (gateMock.approved) return;
      throw new actual.ScrydexCreditsNotApproved(op, actual.estimateCredits(op, count));
    }),
    isScrydexLiveApproved: vi.fn(async () => gateMock.approved),
  };
});

// redis singleton — only `.del` is exercised by the writer; keep it a spy.
const redisMock = vi.hoisted(() => ({ del: vi.fn(async () => 1) }));
vi.mock("@/lib/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/redis")>();
  return { ...actual, redis: redisMock };
});

// Fail-open cache helpers — spies so we can assert the READ route uses the NEW
// soldRows key (and never the legacy ebaySold key).
const cacheMock = vi.hoisted(() => ({
  cacheGetJson: vi.fn(async () => null),
  cacheSetJson: vi.fn(async () => undefined),
}));
vi.mock("@/lib/utils/cache", () => cacheMock);

import { pullAndStoreSoldListings } from "@/lib/services/scrydex-pricing.service";
import { GET } from "@/app/api/cards/[id]/ebay-sold/route";
import {
  ScrydexCreditsNotApproved,
  isScrydexLiveApproved,
  type ScrydexOp,
} from "@/lib/services/scrydex-credit-gate";
import { RedisKeys } from "@/lib/redis";

beforeEach(() => {
  vi.clearAllMocks();
  gateMock.approved = false;
  cacheMock.cacheGetJson.mockResolvedValue(null);
});

// --- D2: pullAndStoreSoldListings (writer) ----------------------------------

describe("pullAndStoreSoldListings (credit-gated single writer)", () => {
  const CARD = { id: "card_1", scrydexId: "me55c-4", game: Game.POKEMON };

  it("throws ScrydexCreditsNotApproved and makes NO fetch when the gate is denied", async () => {
    gateMock.approved = false;

    await expect(pullAndStoreSoldListings("base1-4")).rejects.toBeInstanceOf(
      ScrydexCreditsNotApproved
    );

    expect(scrydexMock.fetchScrydexSoldListings).not.toHaveBeenCalled();
    expect(prismaMock.soldListing.upsert).not.toHaveBeenCalled();
    expect(prismaMock.card.findFirst).not.toHaveBeenCalled();
  });

  it("upserts each sold_at-bearing record on [cardId,itemId] and deletes the soldRows key", async () => {
    gateMock.approved = true;
    prismaMock.card.findFirst.mockResolvedValue(CARD);
    scrydexMock.fetchScrydexSoldListings.mockResolvedValue([
      {
        id: "ebay_1",
        source: "ebay",
        title: "Charizard PSA 10",
        price: 7930,
        currency: "USD",
        sold_at: "2026-06-01",
        grade: "10",
        company: "PSA",
        url: "https://example.com/1",
      },
      {
        id: "ebay_2",
        source: "ebay",
        title: "Charizard raw",
        price: 350,
        currency: "USD",
        sold_at: "2026-05-20",
        grade: null,
        company: null,
        url: null,
      },
    ]);

    const result = await pullAndStoreSoldListings("base1-4");

    expect(result).toEqual({ stored: 2, credits: 1 });
    expect(prismaMock.soldListing.upsert).toHaveBeenCalledTimes(2);
    // Upsert keyed on the compound [cardId,itemId] unique.
    expect(prismaMock.soldListing.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cardId_itemId: { cardId: "card_1", itemId: "ebay_1" } },
      })
    );
    // ok SyncLog under the NEW scrydex_listings job label.
    expect(prismaMock.syncLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          job: "scrydex_listings",
          cardId: "card_1",
          status: "ok",
          credits: 1,
        }),
      })
    );
    // Best-effort invalidation of the NEW soldRows key (never the legacy one).
    expect(redisMock.del).toHaveBeenCalledWith(RedisKeys.soldRows("card_1"));
  });

  it("is idempotent — a repeat pull upserts the SAME [cardId,itemId], never a duplicate insert", async () => {
    gateMock.approved = true;
    prismaMock.card.findFirst.mockResolvedValue(CARD);
    const rec = {
      id: "ebay_1",
      source: "ebay",
      price: 7930,
      currency: "USD",
      sold_at: "2026-06-01",
      grade: "10",
      company: "PSA",
    };
    scrydexMock.fetchScrydexSoldListings.mockResolvedValue([rec]);

    await pullAndStoreSoldListings("base1-4");
    await pullAndStoreSoldListings("base1-4");

    // Two pulls -> two upserts on the SAME key (idempotent); upsert, never create.
    expect(prismaMock.soldListing.upsert).toHaveBeenCalledTimes(2);
    for (const call of prismaMock.soldListing.upsert.mock.calls) {
      expect(call[0].where).toEqual({ cardId_itemId: { cardId: "card_1", itemId: "ebay_1" } });
    }
  });

  it("synthesizes itemId from sold_at+price when the record has no id", async () => {
    gateMock.approved = true;
    prismaMock.card.findFirst.mockResolvedValue(CARD);
    scrydexMock.fetchScrydexSoldListings.mockResolvedValue([
      { source: "ebay", price: 42, currency: "USD", sold_at: "2026-01-01" },
    ]);

    await pullAndStoreSoldListings("base1-4");

    expect(prismaMock.soldListing.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cardId_itemId: { cardId: "card_1", itemId: "2026-01-01-42" } },
      })
    );
  });

  it("writes a failed SyncLog and stores nothing when the card can't be resolved", async () => {
    gateMock.approved = true;
    prismaMock.card.findFirst.mockResolvedValue(null);
    scrydexMock.resolveScrydexCard.mockResolvedValue(null);

    const result = await pullAndStoreSoldListings("unknown");

    expect(result).toEqual({ stored: 0, credits: 1 });
    expect(scrydexMock.fetchScrydexSoldListings).not.toHaveBeenCalled();
    expect(prismaMock.soldListing.upsert).not.toHaveBeenCalled();
    expect(prismaMock.syncLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ job: "scrydex_listings", status: "failed", credits: 1 }),
      })
    );
  });

  it("writes a failed SyncLog and does NOT clobber on a null fetch", async () => {
    gateMock.approved = true;
    prismaMock.card.findFirst.mockResolvedValue(CARD);
    scrydexMock.fetchScrydexSoldListings.mockResolvedValue(null);

    const result = await pullAndStoreSoldListings("base1-4");

    expect(result).toEqual({ stored: 0, credits: 1 });
    expect(prismaMock.soldListing.upsert).not.toHaveBeenCalled();
    expect(prismaMock.syncLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ job: "scrydex_listings", status: "failed", credits: 1 }),
      })
    );
  });
});

// --- D3: GET /api/cards/[id]/ebay-sold (pure Postgres read) ------------------

function soldRequest(id: string): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`http://localhost/api/cards/${id}/ebay-sold`),
    { params: Promise.resolve({ id }) },
  ];
}

describe("GET /api/cards/[id]/ebay-sold (pure Postgres read, NO credit gate)", () => {
  it("reads SoldListing from Postgres (no live fetch, no gate) and maps to SoldRecord[]", async () => {
    prismaMock.card.findFirst.mockResolvedValue({ id: "card_1" });
    prismaMock.soldListing.findMany.mockResolvedValue([
      {
        itemId: "ebay_1",
        source: "ebay",
        title: "Charizard PSA 10",
        price: 7930,
        currency: "USD",
        soldAt: new Date("2026-06-01T00:00:00.000Z"),
        grade: "10",
        company: "PSA",
        url: "https://example.com/1",
      },
    ]);

    const res = await GET(...soldRequest("base1-4"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.listings).toHaveLength(1);
    expect(body.listings[0]).toMatchObject({
      itemId: "ebay_1",
      price: 7930,
      company: "PSA",
      grade: "10",
      soldAt: "2026-06-01T00:00:00.000Z", // Date -> ISO string
    });

    // Read ordered soldAt desc nulls-last, limited to 8.
    expect(prismaMock.soldListing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cardId: "card_1" },
        orderBy: { soldAt: { sort: "desc", nulls: "last" } },
        take: 8,
      })
    );

    // PURE READ: the credit gate is NEVER consulted and no live fetch happens.
    expect(isScrydexLiveApproved).not.toHaveBeenCalled();
    expect(scrydexMock.fetchScrydexSoldListings).not.toHaveBeenCalled();
  });

  it("uses the NEW soldRows read-through key, NOT the legacy ebaySold key", async () => {
    prismaMock.card.findFirst.mockResolvedValue({ id: "card_1" });
    prismaMock.soldListing.findMany.mockResolvedValue([]);

    await GET(...soldRequest("base1-4"));

    const soldKey = RedisKeys.soldRows("card_1");
    expect(cacheMock.cacheGetJson).toHaveBeenCalledWith(soldKey);
    // Legacy key must never be touched by the rewritten route.
    const legacy = RedisKeys.ebaySold("x");
    expect(cacheMock.cacheGetJson.mock.calls.flat()).not.toContain(legacy);
  });

  it("returns { listings: [] } + HTTP 200 for an unknown card", async () => {
    prismaMock.card.findFirst.mockResolvedValue(null);

    const res = await GET(...soldRequest("missing"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ listings: [] });
    expect(prismaMock.soldListing.findMany).not.toHaveBeenCalled();
  });

  it("returns { listings: [] } + HTTP 200 for a known card with no sold rows", async () => {
    prismaMock.card.findFirst.mockResolvedValue({ id: "card_1" });
    prismaMock.soldListing.findMany.mockResolvedValue([]);

    const res = await GET(...soldRequest("base1-4"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.listings).toEqual([]);
  });
});
