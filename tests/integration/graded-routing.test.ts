import { describe, it, expect, vi, beforeEach } from "vitest";
import { Game } from "@prisma/client";

/**
 * FR-6 (AC-16) — graded-price routing + the GET /api/cards/[id]/graded route.
 *
 * Two layers:
 *   1. resolveGradedPrice (pure): a Scrydex priceSource yielding a PSA market
 *      returns it with isFallback:false; null → the curated/multiplier value
 *      with isFallback:true (reuses the golden fixture numbers).
 *   2. The route (mocked Prisma + pullAndStoreScrydexPrice + pickGradedPrice):
 *      a priced Scrydex-PSA card returns {price,isFallback:false}; an unknown
 *      or unpriced card returns {price:null} + HTTP 200 (NFR-4 — never 4xx/5xx).
 */

import { resolveGradedPrice } from "@/lib/utils/graded-price";

// --- Layer 1: resolveGradedPrice ⇄ Scrydex priceSource --------------------

describe("resolveGradedPrice with a Scrydex PSA priceSource", () => {
  it("uses the live Scrydex PSA market (isFallback:false)", () => {
    const res = resolveGradedPrice({
      cardName: "Charizard",
      setName: "Base Set",
      grade: 10,
      rawMarketPrice: 3500,
      priceSource: () => 42000, // live Scrydex PSA 10 market
    });
    expect(res.price).toBe(42000);
    expect(res.isFallback).toBe(false);
  });

  it("falls back to the curated value (isFallback:true) when Scrydex returns null", () => {
    const res = resolveGradedPrice({
      cardName: "Charizard",
      setName: "Base Set",
      grade: 10,
      rawMarketPrice: 3500,
      priceSource: () => null,
    });
    // Curated Charizard Base Set PSA 10 = $35,000 (graded-price.ts golden).
    expect(res.price).toBe(35000);
    expect(res.isFallback).toBe(true);
  });
});

// --- Layer 2: the GET /api/cards/[id]/graded route ------------------------

const prismaMock = vi.hoisted(() => ({
  card: { findUnique: vi.fn() },
  // The route now reads a STORED graded CurrentPrice row FIRST (the real
  // per-grade price, no fabrication). Default to null so the existing
  // Scrydex/curated-fallback tests exercise that path; one test overrides it.
  currentPrice: { findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const pricingMock = vi.hoisted(() => ({ pullAndStoreScrydexPrice: vi.fn() }));
vi.mock("@/lib/services/scrydex-pricing.service", () => pricingMock);

const scrydexMock = vi.hoisted(() => ({ pickGradedPrice: vi.fn() }));
vi.mock("@/lib/services/scrydex.service", () => scrydexMock);

import { GET } from "@/app/api/cards/[id]/graded/route";

function gradedRequest(externalId: string, grade = "10"): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`http://localhost/api/cards/${externalId}/graded?grade=${grade}`),
    { params: Promise.resolve({ id: externalId }) },
  ];
}

const PRICED_CARD = {
  id: "card_1",
  externalId: "base1-4",
  game: Game.POKEMON,
  name: "Charizard",
  number: "4",
  scrydexId: null,
  marketPrice: 3500,
  lastPricedAt: new Date(),
  set: { name: "Base Set" },
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no stored graded row → route falls through to Scrydex/curated.
  prismaMock.currentPrice.findFirst.mockResolvedValue(null);
});

describe("GET /api/cards/[id]/graded (NFR-4 / AC-16)", () => {
  it("returns {price, isFallback:false} for a priced Scrydex-PSA card", async () => {
    prismaMock.card.findUnique.mockResolvedValue(PRICED_CARD);
    // A fresh pull returns the resolved ScrydexCard; the route reads its PSA entry.
    pricingMock.pullAndStoreScrydexPrice.mockResolvedValue({
      pulled: true,
      credits: 1,
      card: { id: "me55c-4", variants: [] },
    });
    scrydexMock.pickGradedPrice.mockReturnValue({ market: 42000, grade: "10", company: "PSA" });

    const [req, ctx] = gradedRequest("base1-4");
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.price).toBe(42000);
    expect(body.isFallback).toBe(false);
  });

  it("returns the STORED graded CurrentPrice first (isFallback:false, no Scrydex call)", async () => {
    // The real fix: when a per-grade graded CurrentPrice row exists, return it
    // verbatim — the SAME number the detail-page chips show — instead of the
    // fabricated multiplier. No Scrydex pull, no curated fallback.
    prismaMock.card.findUnique.mockResolvedValue(PRICED_CARD);
    prismaMock.currentPrice.findFirst.mockResolvedValue({ priceMarket: 326.17, updatedAt: new Date() });

    const [req, ctx] = gradedRequest("base1-4");
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.price).toBe(326.17);
    expect(body.isFallback).toBe(false);
    // Stored price short-circuits BEFORE any Scrydex refetch or heuristic.
    expect(pricingMock.pullAndStoreScrydexPrice).not.toHaveBeenCalled();
    expect(scrydexMock.pickGradedPrice).not.toHaveBeenCalled();
  });

  it("returns {price:null} + 200 for an UNKNOWN card (never 4xx/5xx)", async () => {
    prismaMock.card.findUnique.mockResolvedValue(null);

    const [req, ctx] = gradedRequest("does-not-exist");
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.price).toBeNull();
    expect(body.isFallback).toBe(true);
    // No Scrydex pull for an unknown card.
    expect(pricingMock.pullAndStoreScrydexPrice).not.toHaveBeenCalled();
  });

  it("returns {price:null} + 200 for an UNPRICED card (marketPrice null)", async () => {
    prismaMock.card.findUnique.mockResolvedValue({ ...PRICED_CARD, marketPrice: null });

    const [req, ctx] = gradedRequest("base1-4");
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.price).toBeNull();
  });

  it("falls back to the curated value (isFallback:true) on a credit-free cache-hit (card:null)", async () => {
    prismaMock.card.findUnique.mockResolvedValue(PRICED_CARD);
    // Gate short-circuited within SCRYDEX_STALE_MS → no live card this call.
    pricingMock.pullAndStoreScrydexPrice.mockResolvedValue({ pulled: false, credits: 0, card: null });

    const [req, ctx] = gradedRequest("base1-4");
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    // Charizard Base Set PSA 10 curated fallback.
    expect(body.price).toBe(35000);
    expect(body.isFallback).toBe(true);
    expect(scrydexMock.pickGradedPrice).not.toHaveBeenCalled();
  });

  it("returns {price:null} + 200 when the DB call throws (NFR-4 catch branch)", async () => {
    prismaMock.card.findUnique.mockRejectedValue(new Error("db down"));

    const [req, ctx] = gradedRequest("base1-4");
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.price).toBeNull();
  });
});
