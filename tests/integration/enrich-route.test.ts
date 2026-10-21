import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextResponse } from "next/server";
import { Game } from "@prisma/client";

/**
 * ON-VIEW enrich route — POST /api/cards/[id]/enrich.
 *
 * Pins the two short-circuits that keep dev/verification credit-free:
 *   (a) with SCRYDEX_ONVIEW_ENABLED UNSET (allowance off) AND the big-bulk
 *       credit gate DENY, the route returns {enriched:false} and calls NEITHER
 *       pullAndStoreScrydexHistory NOR pullAndStorePopulation (no Scrydex HTTP).
 *   (b) when the card already has stored history AND a population refreshed
 *       within the 24h window, the route is a no-op
 *       {enriched:false,reason:"fresh"} without calling the services — even if
 *       the allowance were on (owner spec: pull-on-open only after 24h).
 *
 * Mocked Prisma + Scrydex service + population reader + Redis — ZERO network,
 * ZERO credits, no live DB. The allowance is env-only; we never set the flag.
 */

// SECURITY: the enrich POST now requires a session (it can trigger a live
// Scrydex credit spend). Mock the guard: default authed; one case overrides it
// to the unauthorized shape to pin the 401.
const guardMock = vi.hoisted(() => ({
  requireAuth: vi.fn<() => Promise<{ unauthorized: unknown; session: unknown }>>(async () => ({
    unauthorized: null,
    session: { user: { id: "user_1" } },
  })),
}));
vi.mock("@/lib/utils/auth-guard", () => guardMock);

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
  // Default: authenticated session so the existing credit-gate cases run.
  guardMock.requireAuth.mockResolvedValue({
    unauthorized: null,
    session: { user: { id: "user_1" } },
  });
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

  it("(b) fresh within 24h (has history + recent population) → {enriched:false}, NO service call", async () => {
    // Owner spec: a card enriched <24h ago is served from the store on open —
    // no pull, no credit. Even with the allowance ON, a card refreshed 23h ago
    // (inside the 24h window) must not spend.
    process.env.SCRYDEX_ONVIEW_ENABLED = "true";
    prismaMock.card.findUnique.mockResolvedValue(KNOWN_CARD);
    prismaMock.pricingHistory.count.mockResolvedValue(5);
    populationMock.getStoredPopulationReport.mockResolvedValue({
      source: "scrydex",
      companies: [],
      refreshedAt: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(), // 23h ago → still fresh
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

  it("(c) stale > 24h → re-pulls once (calls both services) on open when allowance ON", async () => {
    // Owner spec: the first open AFTER 24h re-pulls once. A card last refreshed
    // 25h ago is re-enriched on this view (triggered by the user opening the
    // card — never a background job).
    process.env.SCRYDEX_ONVIEW_ENABLED = "true";
    prismaMock.card.findUnique.mockResolvedValue(KNOWN_CARD);
    prismaMock.pricingHistory.count.mockResolvedValue(5);
    prismaMock.currentPrice.findMany.mockResolvedValue([]);
    populationMock.getStoredPopulationReport.mockResolvedValue({
      source: "scrydex",
      companies: [],
      refreshedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25h old → stale
    });

    const [req, ctx] = enrichRequest("base1-4");
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.enriched).toBe(true);
    expect(pricingMock.pullAndStoreScrydexHistory).toHaveBeenCalledTimes(1);
    expect(pricingMock.pullAndStorePopulation).toHaveBeenCalledTimes(1);
  });

  it("SECURITY: unauthenticated POST → 401, NO Scrydex service call (closes credit drain)", async () => {
    // The POST can trigger a live credit spend; an anonymous caller must be
    // rejected BEFORE any card resolve / flag check / pull.
    guardMock.requireAuth.mockResolvedValue({
      unauthorized: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      session: null,
    });

    const [req, ctx] = enrichRequest("base1-4");
    const res = await POST(req, ctx);

    expect(res.status).toBe(401);
    expect(prismaMock.card.findUnique).not.toHaveBeenCalled();
    expect(pricingMock.pullAndStoreScrydexHistory).not.toHaveBeenCalled();
    expect(pricingMock.pullAndStorePopulation).not.toHaveBeenCalled();
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
