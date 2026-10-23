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
 *   (b) when a per-card enrich marker SyncLog(job="scrydex_onview_enrich") was
 *       written within the 24h window, the route is a no-op
 *       {enriched:false,reason:"fresh"} without calling the services — even if
 *       the allowance were on (owner spec: pull-on-open only after 24h). Bug C:
 *       this marker (NOT population-presence) is the freshness clock, so a
 *       pop-less card is throttled too (the P-02 regression below).
 *
 * Mocked Prisma + Scrydex service + Redis — ZERO network, ZERO credits, no live
 * DB. The allowance is env-only; we never set the flag.
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
  // Bug C: freshness now keys on a per-card SyncLog marker
  // (job="scrydex_onview_enrich") instead of population-presence. findFirst
  // reads the last marker; create writes the attempt marker after the pulls.
  syncLog: { findFirst: vi.fn(), create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const pricingMock = vi.hoisted(() => ({
  pullAndStoreScrydexHistory: vi.fn(),
  pullAndStorePopulation: vi.fn(),
  // The enrich route no longer pulls recent eBay SOLD listings — those are
  // button-gated via POST /api/cards/[id]/ebay-sold. We still mock the symbol
  // so a regression (enrich re-importing/calling it) is caught by the
  // not.toHaveBeenCalled assertions below — ZERO network, ZERO credits.
  pullAndStoreSoldListings: vi.fn(),
  // The per-printing weekly-delta side-write (search-grid ▲/▼ for `::` rows),
  // same on-view auth + fail-open contract. Mock it so the route wiring is
  // pinned — ZERO network, ZERO credits.
  pullAndStoreScrydexWeeklyDelta: vi.fn(),
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
  // A per-printing (`::`) row carries its variant label in `printing`; the
  // route passes it straight to the weekly-delta writer (printing passthrough).
  printing: "reverse holofoil",
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
  // Bug C freshness-marker defaults: no prior marker (stale), writes succeed.
  prismaMock.syncLog.findFirst.mockResolvedValue(null);
  prismaMock.syncLog.create.mockResolvedValue({});
  prismaMock.currentPrice.findMany.mockResolvedValue([]);
  // Default pull results so the route's `r.stored` reads are well-defined.
  pricingMock.pullAndStoreScrydexHistory.mockResolvedValue({ stored: 0, credits: 0 });
  pricingMock.pullAndStorePopulation.mockResolvedValue({ stored: false, credits: 0 });
  pricingMock.pullAndStoreScrydexWeeklyDelta.mockResolvedValue({ written: true, credits: 1 });
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
    // Enrich never pulls sold listings (reverted to button-gated), and the
    // short-circuit calls no Scrydex service at all.
    expect(pricingMock.pullAndStoreSoldListings).not.toHaveBeenCalled();
    expect(pricingMock.pullAndStoreScrydexWeeklyDelta).not.toHaveBeenCalled();
    // Short-circuit happens before any freshness query (the SyncLog marker read).
    expect(prismaMock.syncLog.findFirst).not.toHaveBeenCalled();
  });

  it("(b) fresh within 24h (recent enrich marker) → {enriched:false}, NO service call", async () => {
    // Owner spec: a card enriched <24h ago is served from the store on open —
    // no pull, no credit. Even with the allowance ON, a card whose last enrich
    // marker is 23h old (inside the 24h window) must not spend.
    process.env.SCRYDEX_ONVIEW_ENABLED = "true";
    prismaMock.card.findUnique.mockResolvedValue(KNOWN_CARD);
    prismaMock.syncLog.findFirst.mockResolvedValue({
      ranAt: new Date(Date.now() - 23 * 60 * 60 * 1000), // 23h ago → still fresh
    });

    const [req, ctx] = enrichRequest("base1-4");
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.enriched).toBe(false);
    expect(body.reason).toBe("fresh");
    expect(pricingMock.pullAndStoreScrydexHistory).not.toHaveBeenCalled();
    expect(pricingMock.pullAndStorePopulation).not.toHaveBeenCalled();
    expect(pricingMock.pullAndStoreScrydexWeeklyDelta).not.toHaveBeenCalled();
    // Fresh short-circuit does not write a new marker.
    expect(prismaMock.syncLog.create).not.toHaveBeenCalled();
  });

  it("(c) stale > 24h → re-pulls once (calls both services) + writes marker when allowance ON", async () => {
    // Owner spec: the first open AFTER 24h re-pulls once. A marker 25h old is
    // stale → re-enriched on this view (triggered by the user opening the card —
    // never a background job).
    process.env.SCRYDEX_ONVIEW_ENABLED = "true";
    prismaMock.card.findUnique.mockResolvedValue(KNOWN_CARD);
    prismaMock.syncLog.findFirst.mockResolvedValue({
      ranAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25h old → stale
    });

    const [req, ctx] = enrichRequest("base1-4");
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.enriched).toBe(true);
    // Enrich pulls ONLY history + population now — the response carries no
    // `sales` field and no sold-listings pull is ever invoked.
    expect(body).toEqual({ enriched: true, history: { stored: 0 }, population: { stored: false } });
    expect(body.sales).toBeUndefined();
    expect(pricingMock.pullAndStoreSoldListings).not.toHaveBeenCalled();
    expect(pricingMock.pullAndStoreScrydexHistory).toHaveBeenCalledTimes(1);
    expect(pricingMock.pullAndStorePopulation).toHaveBeenCalledTimes(1);
    // The per-printing weekly-delta side-write runs on the stale path too, with
    // the card's printing passed through and authorized by the on-view allowance.
    expect(pricingMock.pullAndStoreScrydexWeeklyDelta).toHaveBeenCalledWith(
      {
        id: "card_1",
        game: Game.POKEMON,
        scrydexId: "me55c-4",
        printing: KNOWN_CARD.printing ?? undefined,
      },
      { creditAuth: "onview" }
    );
    // The 24h clock is (re)started by writing a fresh marker.
    expect(prismaMock.syncLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ job: "scrydex_onview_enrich", cardId: "card_1" }),
      })
    );
  });

  it("(P-02) pop-less + history-less card is NOT re-pulled within 24h (marker throttles)", async () => {
    // The regression: a card that legitimately has no population AND no history
    // used to never be "fresh" and re-pulled on EVERY open. With the marker
    // model a 1h-old marker throttles it regardless of stored data.
    process.env.SCRYDEX_ONVIEW_ENABLED = "true";
    prismaMock.card.findUnique.mockResolvedValue(KNOWN_CARD);
    prismaMock.pricingHistory.count.mockResolvedValue(0); // no history
    populationMock.getStoredPopulationReport.mockResolvedValue(null); // no population
    prismaMock.syncLog.findFirst.mockResolvedValue({
      ranAt: new Date(Date.now() - 1 * 60 * 60 * 1000), // 1h ago → fresh
    });

    const [req, ctx] = enrichRequest("op01-120");
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.enriched).toBe(false);
    expect(body.reason).toBe("fresh");
    expect(pricingMock.pullAndStoreScrydexHistory).not.toHaveBeenCalled();
    expect(pricingMock.pullAndStorePopulation).not.toHaveBeenCalled();
    expect(pricingMock.pullAndStoreScrydexWeeklyDelta).not.toHaveBeenCalled();
  });

  it("first-ever open (no marker) pulls once AND writes the enrich marker", async () => {
    process.env.SCRYDEX_ONVIEW_ENABLED = "true";
    prismaMock.card.findUnique.mockResolvedValue(KNOWN_CARD);
    prismaMock.syncLog.findFirst.mockResolvedValue(null); // never enriched

    const [req, ctx] = enrichRequest("base1-4");
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.enriched).toBe(true);
    // Only history + population; no sales field, no sold-listings pull.
    expect(body.sales).toBeUndefined();
    expect(pricingMock.pullAndStoreSoldListings).not.toHaveBeenCalled();
    expect(pricingMock.pullAndStoreScrydexHistory).toHaveBeenCalledTimes(1);
    expect(pricingMock.pullAndStorePopulation).toHaveBeenCalledTimes(1);
    expect(pricingMock.pullAndStoreScrydexWeeklyDelta).toHaveBeenCalledTimes(1);
    expect(pricingMock.pullAndStoreScrydexWeeklyDelta).toHaveBeenCalledWith(
      expect.anything(),
      { creditAuth: "onview" }
    );
    expect(prismaMock.syncLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          job: "scrydex_onview_enrich",
          cardId: "card_1",
          credits: 0,
        }),
      })
    );
  });

  it("(weekly-delta fail-open) a thrown weekly-delta side-write does NOT 5xx; marker + other pulls still run", async () => {
    // RULE 7: a ScrydexCreditsNotApproved / transient throw from the delta
    // side-write must be swallowed — the route always returns 200, the two
    // pulls ran, and the 24h marker is still written. The delta is NOT in the
    // body, so a swallowed throw leaves the {enriched,history,population} shape
    // intact.
    process.env.SCRYDEX_ONVIEW_ENABLED = "true";
    prismaMock.card.findUnique.mockResolvedValue(KNOWN_CARD);
    prismaMock.syncLog.findFirst.mockResolvedValue(null);
    pricingMock.pullAndStoreScrydexHistory.mockResolvedValue({ stored: 5, credits: 3 });
    pricingMock.pullAndStorePopulation.mockResolvedValue({ stored: true, credits: 1 });
    pricingMock.pullAndStoreScrydexWeeklyDelta.mockRejectedValue(new Error("boom"));

    const [req, ctx] = enrichRequest("base1-4");
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.enriched).toBe(true);
    // The two pulls still surfaced their stored counts; no sales field.
    expect(body.history).toEqual({ stored: 5 });
    expect(body.population).toEqual({ stored: true });
    expect(body.sales).toBeUndefined();
    expect(pricingMock.pullAndStoreSoldListings).not.toHaveBeenCalled();
    expect(pricingMock.pullAndStoreScrydexWeeklyDelta).toHaveBeenCalledTimes(1);
    // The 24h marker is still written despite the thrown side-write.
    expect(prismaMock.syncLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ job: "scrydex_onview_enrich", cardId: "card_1" }),
      })
    );
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
    expect(pricingMock.pullAndStoreScrydexWeeklyDelta).not.toHaveBeenCalled();
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
    expect(pricingMock.pullAndStoreSoldListings).not.toHaveBeenCalled();
    expect(pricingMock.pullAndStoreScrydexWeeklyDelta).not.toHaveBeenCalled();
  });

  it("enrich NEVER pulls sold listings (that is the button-gated ebay-sold POST)", async () => {
    // The sales pull was reverted OUT of enrich: opening a card auto-loads only
    // history + population (+ the weekly-delta side-write). The sold-listings
    // writer must not be invoked on ANY enrich path, and the 200 body carries
    // no `sales` field (shape = {enriched,history,population}).
    process.env.SCRYDEX_ONVIEW_ENABLED = "true";
    prismaMock.card.findUnique.mockResolvedValue(KNOWN_CARD);
    prismaMock.syncLog.findFirst.mockResolvedValue(null); // never enriched → stale
    pricingMock.pullAndStoreScrydexHistory.mockResolvedValue({ stored: 5, credits: 3 });
    pricingMock.pullAndStorePopulation.mockResolvedValue({ stored: true, credits: 1 });

    const [req, ctx] = enrichRequest("base1-4");
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      enriched: true,
      history: { stored: 5 },
      population: { stored: true },
    });
    expect(body.sales).toBeUndefined();
    expect(pricingMock.pullAndStoreSoldListings).not.toHaveBeenCalled();
  });
});
