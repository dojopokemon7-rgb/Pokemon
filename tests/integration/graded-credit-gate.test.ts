import { describe, it, expect, vi, beforeEach } from "vitest";
import { Game } from "@prisma/client";

/**
 * FIX A (sec-audit) — GET /api/cards/[id]/graded must NOT spend a Scrydex
 * credit when live credits are NOT approved.
 *
 * Unlike graded-routing.test.ts (which mocks pullAndStoreScrydexPrice), this
 * suite exercises the REAL pricing service so the soft credit gate at the top
 * of pullAndStoreScrydexPrice is the thing under test. We mock only the thin
 * Scrydex client (to prove NO HTTP fetch fires) + the credit gate (OFF) + the
 * stored-graded lookup (null, so the route would otherwise reach the pull).
 */

const gateMock = vi.hoisted(() => ({ approved: false }));
vi.mock("@/lib/services/scrydex-credit-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/scrydex-credit-gate")>();
  return {
    ...actual,
    isScrydexLiveApproved: vi.fn(async () => gateMock.approved),
    assertScrydexCreditsApproved: vi.fn(async (op, count = 1) => {
      if (gateMock.approved) return;
      throw new actual.ScrydexCreditsNotApproved(op, actual.estimateCredits(op, count));
    }),
  };
});

// The thin Scrydex client: fetchScrydexCardById / resolveScrydexCard are the
// only credit-spending HTTP calls. Assert they are never invoked when OFF.
const scrydexMock = vi.hoisted(() => ({
  fetchScrydexCardById: vi.fn(),
  resolveScrydexCard: vi.fn(),
  pickRawPrice: vi.fn(),
  pickGradedPrice: vi.fn(() => null),
}));
vi.mock("@/lib/services/scrydex.service", () => scrydexMock);

const prismaMock = vi.hoisted(() => ({
  card: { findUnique: vi.fn(), update: vi.fn() },
  currentPrice: { findFirst: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
  syncLog: { findFirst: vi.fn(), create: vi.fn() },
  pricingHistory: { count: vi.fn(), createMany: vi.fn() },
  userCollection: { updateMany: vi.fn() },
  $transaction: vi.fn(async (ops: unknown) => (Array.isArray(ops) ? ops : [])),
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import { GET } from "@/app/api/cards/[id]/graded/route";

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
  gateMock.approved = false;
  // Priced card, but NO stored graded row → the route would reach the pull.
  prismaMock.card.findUnique.mockResolvedValue(PRICED_CARD);
  prismaMock.currentPrice.findFirst.mockResolvedValue(null);
  prismaMock.syncLog.findFirst.mockResolvedValue(null);
});

describe("GET /api/cards/[id]/graded — no credit spend when approval OFF (FIX A)", () => {
  it("returns 200 + curated fallback and makes NO Scrydex HTTP fetch", async () => {
    const req = new Request("http://localhost/api/cards/base1-4/graded?grade=10");
    const res = await GET(req, { params: Promise.resolve({ id: "base1-4" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    // Gate OFF → pull is a no-op (card:null) → curated fallback, never a live quote.
    expect(body.isFallback).toBe(true);
    // The whole point: zero credit-spending HTTP to Scrydex.
    expect(scrydexMock.fetchScrydexCardById).not.toHaveBeenCalled();
    expect(scrydexMock.resolveScrydexCard).not.toHaveBeenCalled();
  });
});
