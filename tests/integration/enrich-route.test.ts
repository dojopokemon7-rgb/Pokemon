import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Game } from "@prisma/client";

/**
 * ON-VIEW enrich route — POST /api/cards/[id]/enrich.
 *
 * Pins the two short-circuits that keep dev/verification credit-free:
 *   (a) with SCRYDEX_ONVIEW_ENABLED UNSET (allowance off) AND the big-bulk
 *       credit gate DENY, the route returns {enriched:false} and calls NEITHER
 *       pullAndStoreScrydexHistory NOR pullAndStorePopulation (no Scrydex HTTP).
 *   (b) when the card already has stored history AND population, the route is a
 *       no-op {enriched:false,reason:"fresh"} without calling the services —
 *       even if the allowance were on.
 *
 * Mocked Prisma + Scrydex service + population reader + Redis — ZERO network,
 * ZERO credits, no live DB. The allowance is env-only; we never set the flag.
 */

const prismaMock = vi.hoisted(() => ({
  card: { findUnique: vi.fn() },
  pricingHistory: { count: vi.fn() },
  currentPrice: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const pricingMock = vi.hoisted(() => ({
  pullAndStoreScrydexHistory: vi.fn(),
  pullAndStorePopulation: vi.fn(),
}));
vi.mock("@/lib/services/scrydex-pricing.service", () => pricingMock);

const populationMock = vi.hoisted(() => ({ getStoredPopulationReport: vi.fn() }));
vi.mock("@/lib/services/population.service", () => populationMock);

const redisMock = vi.hoisted(() => ({
  redis: { del: vi.fn() },
  RedisKeys: { cardHistory: (id: string) => `h:${id}`, cardPopulation: (id: string) => `p:${id}` },
}));
vi.mock("@/lib/redis", () => redisMock);

import { POST } from "@/app/api/cards/[id]/enrich/route";

const KNOWN_CARD = {
  id: "card_1",
  game: Game.POKEMON,
  scrydexId: "me55c-4",
  name: "Charizard",
  number: "4",
  set: { name: "Base Set" },
};

function enrichRequest(externalId: string): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`http://localhost/api/cards/${externalId}/enrich`, { method: "POST" }),
    { params: Promise.resolve({ id: externalId }) },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  // Clear the Scrydex flags BEFORE each test so the suite is deterministic
  // regardless of ambient env. The project's .env now sets
  // SCRYDEX_ONVIEW_ENABLED=true (prod on-view enrichment), which would leak into
  // the first test and make the "allowance OFF" case (a) wrongly fall through
  // the short-circuit. Each test opts IN to the flags it needs.
  delete process.env.SCRYDEX_ONVIEW_ENABLED;
  delete process.env.SCRYDEX_LIVE_CREDITS_APPROVED;
});

afterEach(() => {
  delete process.env.SCRYDEX_ONVIEW_ENABLED;
  delete process.env.SCRYDEX_LIVE_CREDITS_APPROVED;
});

describe("POST /api/cards/[id]/enrich", () => {
  it("(a) allowance OFF + gate DENY → {enriched:false}, NO Scrydex service call", async () => {
    // Both flags unset: allowance off (env) and bulk gate deny.
    prismaMock.card.findUnique.mockResolvedValue(KNOWN_CARD);

    const [req, ctx] = enrichRequest("base1-4");
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.enriched).toBe(false);
    expect(pricingMock.pullAndStoreScrydexHistory).not.toHaveBeenCalled();
    expect(pricingMock.pullAndStorePopulation).not.toHaveBeenCalled();
    // Short-circuit happens before any freshness query.
    expect(prismaMock.pricingHistory.count).not.toHaveBeenCalled();
  });

  it("(b) fresh within 7 days (has history + recent population) → {enriched:false}, NO service call", async () => {
    // Even with the allowance ON, a card refreshed within the 7-day window must
    // not spend — this is the once-per-week credit guard. refreshedAt = now.
    process.env.SCRYDEX_ONVIEW_ENABLED = "true";
    prismaMock.card.findUnique.mockResolvedValue(KNOWN_CARD);
    prismaMock.pricingHistory.count.mockResolvedValue(5);
    populationMock.getStoredPopulationReport.mockResolvedValue({
      source: "scrydex",
      companies: [],
      refreshedAt: new Date().toISOString(), // refreshed just now → fresh
    });

    const [req, ctx] = enrichRequest("base1-4");
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.enriched).toBe(false);
    expect(body.reason).toBe("fresh");
    expect(pricingMock.pullAndStoreScrydexHistory).not.toHaveBeenCalled();
    expect(pricingMock.pullAndStorePopulation).not.toHaveBeenCalled();
  });

  it("(c) stale > 7 days → refreshes once (calls both services) when allowance ON", async () => {
    // A card last refreshed 8 days ago is re-enriched on this view (the weekly
    // refresh, triggered by the user opening the card).
    process.env.SCRYDEX_ONVIEW_ENABLED = "true";
    prismaMock.card.findUnique.mockResolvedValue(KNOWN_CARD);
    prismaMock.pricingHistory.count.mockResolvedValue(5);
    prismaMock.currentPrice.findMany.mockResolvedValue([]);
    populationMock.getStoredPopulationReport.mockResolvedValue({
      source: "scrydex",
      companies: [],
      refreshedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), // 8 days old
    });

    const [req, ctx] = enrichRequest("base1-4");
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.enriched).toBe(true);
    expect(pricingMock.pullAndStoreScrydexHistory).toHaveBeenCalledTimes(1);
    expect(pricingMock.pullAndStorePopulation).toHaveBeenCalledTimes(1);
  });

  it("returns {enriched:false,reason:'unknown'} + 200 for an unknown card (never 4xx)", async () => {
    prismaMock.card.findUnique.mockResolvedValue(null);

    const [req, ctx] = enrichRequest("does-not-exist");
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.enriched).toBe(false);
    expect(body.reason).toBe("unknown");
    expect(pricingMock.pullAndStoreScrydexHistory).not.toHaveBeenCalled();
    expect(pricingMock.pullAndStorePopulation).not.toHaveBeenCalled();
  });
});
