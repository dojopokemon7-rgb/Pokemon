import { describe, it, expect, vi, beforeEach } from "vitest";
import { Game, DataSource } from "@prisma/client";

/**
 * FR-4 (AC-9/11/12) — Scrydex pricing orchestrator (the single writer).
 *
 * Mocks the Prisma singleton AND the thin scrydex.service.ts client so no
 * live network / DB is touched. Pins:
 *   - fresh pull writes one `scrydex` PricingHistory + upserts one
 *     CurrentPrice (source=SCRYDEX) (AC-9);
 *   - the freshness gate SKIPS entirely (no fetch, no row) when the newest
 *     SyncLog(job='scrydex_history', cardId) is within SCRYDEX_STALE_MS, and
 *     PROCEEDS when it is older/absent (AC-11, gated on SyncLog not
 *     CurrentPrice — finding #9);
 *   - every pull writes a SyncLog(status:'ok',credits:1) on success and
 *     (status:'failed',credits:0) when the pull returns null (AC-12).
 */

const prismaMock = vi.hoisted(() => ({
  syncLog: { findFirst: vi.fn(), create: vi.fn() },
  pricingHistory: { count: vi.fn(), createMany: vi.fn() },
  currentPrice: { upsert: vi.fn() },
  card: { update: vi.fn() },
  // Lazy cost-basis resolution writes to userCollection.updateMany after a
  // successful priced pull (plan §5) — mock it so the resolver path runs.
  userCollection: { updateMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

// Mock the thin client so we control what a "pull" resolves to.
const scrydexMock = vi.hoisted(() => ({
  resolveScrydexCard: vi.fn(),
  fetchScrydexCardById: vi.fn(),
  pickRawPrice: vi.fn(),
}));
vi.mock("@/lib/services/scrydex.service", () => scrydexMock);

import {
  pullAndStoreScrydexPrice,
  SCRYDEX_STALE_MS,
  SCRYDEX_CREDITS_PER_CALL,
} from "@/lib/services/scrydex-pricing.service";

const CARD = {
  id: "card_cuid_1",
  externalId: "base1-4",
  name: "Charizard",
  number: "4",
  game: Game.POKEMON,
  scrydexId: null,
  setName: "Base Set",
  setCode: null,
};

const RESOLVED = {
  scrydexId: "me55c-4",
  card: { id: "me55c-4", name: "Charizard", number: "4", variants: [] },
};

const RAW = {
  market: 191.34,
  low: 170,
  currency: "USD",
  trends: null,
  variant: "holofoil",
  condition: "NM",
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no prior SyncLog → gate is open.
  prismaMock.syncLog.findFirst.mockResolvedValue(null);
  prismaMock.pricingHistory.count.mockResolvedValue(1); // not a first pull by default
  prismaMock.pricingHistory.createMany.mockResolvedValue({ count: 1 });
  prismaMock.currentPrice.upsert.mockResolvedValue({});
  prismaMock.syncLog.create.mockResolvedValue({});
  prismaMock.card.update.mockResolvedValue({});
  prismaMock.userCollection.updateMany.mockResolvedValue({ count: 0 });
});

describe("pullAndStoreScrydexPrice — fresh pull (AC-9/12)", () => {
  it("writes one scrydex PricingHistory + one CurrentPrice and a success SyncLog", async () => {
    scrydexMock.resolveScrydexCard.mockResolvedValue(RESOLVED);
    scrydexMock.pickRawPrice.mockReturnValue(RAW);

    const result = await pullAndStoreScrydexPrice(CARD);

    expect(result.pulled).toBe(true);
    expect(result.credits).toBe(SCRYDEX_CREDITS_PER_CALL);

    // One PricingHistory row, source='scrydex'.
    const histArg = prismaMock.pricingHistory.createMany.mock.calls[0][0];
    expect(histArg.data).toHaveLength(1);
    expect(histArg.data[0]).toMatchObject({
      cardId: CARD.id,
      priceMarket: 191.34,
      priceLow: 170,
      source: "scrydex",
      variant: "holofoil",
      condition: "NM",
    });

    // One CurrentPrice upsert keyed by [cardId,source,currency,variant,condition].
    const upsertArg = prismaMock.currentPrice.upsert.mock.calls[0][0];
    expect(upsertArg.where.cardId_source_currency_variant_condition).toMatchObject({
      cardId: CARD.id,
      source: DataSource.SCRYDEX,
      currency: "USD",
      variant: "holofoil",
      condition: "NM",
    });

    // SyncLog ok + credits.
    expect(prismaMock.syncLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ job: "scrydex_history", cardId: CARD.id, status: "ok", credits: 1 }),
      })
    );
  });

  it("caches the resolved scrydexId back onto the Card", async () => {
    scrydexMock.resolveScrydexCard.mockResolvedValue(RESOLVED);
    scrydexMock.pickRawPrice.mockReturnValue(RAW);

    await pullAndStoreScrydexPrice(CARD);

    expect(prismaMock.card.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CARD.id },
        data: { scrydexId: "me55c-4" },
      })
    );
  });
});

describe("pullAndStoreScrydexPrice — freshness gate (AC-11)", () => {
  it("SKIPS entirely (no fetch, no row) when the newest SyncLog is within SCRYDEX_STALE_MS", async () => {
    prismaMock.syncLog.findFirst.mockResolvedValue({
      ranAt: new Date(Date.now() - SCRYDEX_STALE_MS / 2),
    });

    const result = await pullAndStoreScrydexPrice(CARD);

    expect(result).toEqual({ pulled: false, credits: 0, card: null });
    expect(scrydexMock.resolveScrydexCard).not.toHaveBeenCalled();
    expect(scrydexMock.fetchScrydexCardById).not.toHaveBeenCalled();
    expect(prismaMock.pricingHistory.createMany).not.toHaveBeenCalled();
    expect(prismaMock.syncLog.create).not.toHaveBeenCalled();
  });

  it("PROCEEDS when the newest SyncLog is older than SCRYDEX_STALE_MS", async () => {
    prismaMock.syncLog.findFirst.mockResolvedValue({
      ranAt: new Date(Date.now() - SCRYDEX_STALE_MS - 1000),
    });
    scrydexMock.resolveScrydexCard.mockResolvedValue(RESOLVED);
    scrydexMock.pickRawPrice.mockReturnValue(RAW);

    const result = await pullAndStoreScrydexPrice(CARD);
    expect(result.pulled).toBe(true);
    expect(scrydexMock.resolveScrydexCard).toHaveBeenCalled();
  });

  it("PROCEEDS regardless of the gate when opts.force is true", async () => {
    prismaMock.syncLog.findFirst.mockResolvedValue({ ranAt: new Date() });
    scrydexMock.resolveScrydexCard.mockResolvedValue(RESOLVED);
    scrydexMock.pickRawPrice.mockReturnValue(RAW);

    const result = await pullAndStoreScrydexPrice(CARD, { force: true });
    expect(result.pulled).toBe(true);
    expect(prismaMock.syncLog.findFirst).not.toHaveBeenCalled();
  });
});

describe("pullAndStoreScrydexPrice — failed pull (AC-12)", () => {
  it("writes a failed SyncLog (credits 0) and no price rows when the pull returns null", async () => {
    scrydexMock.resolveScrydexCard.mockResolvedValue(null);

    const result = await pullAndStoreScrydexPrice(CARD);

    expect(result).toEqual({ pulled: false, credits: 0, card: null });
    expect(prismaMock.pricingHistory.createMany).not.toHaveBeenCalled();
    expect(prismaMock.currentPrice.upsert).not.toHaveBeenCalled();
    expect(prismaMock.syncLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed", credits: 0, cardId: CARD.id }),
      })
    );
  });

  it("meters a success SyncLog even when the resolved card has no raw price (graded-only)", async () => {
    scrydexMock.resolveScrydexCard.mockResolvedValue(RESOLVED);
    scrydexMock.pickRawPrice.mockReturnValue(null); // graded-only / empty prices

    const result = await pullAndStoreScrydexPrice(CARD);

    expect(result.pulled).toBe(true);
    expect(result.credits).toBe(1);
    // No price rows written, but a success SyncLog is still recorded so the
    // 24h throttle applies (finding #9 — gate reads SyncLog, not CurrentPrice).
    expect(prismaMock.pricingHistory.createMany).not.toHaveBeenCalled();
    expect(prismaMock.syncLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "ok" }) })
    );
  });
});

describe("pullAndStoreScrydexPrice — NO fabricated history (Req 7.2/7.3)", () => {
  // The scrydex-trend derivation is REMOVED. A pull writes EXACTLY ONE real
  // PricingHistory snapshot (source="scrydex") and never derives prior points
  // from trend deltas, even when trends are present. Real multi-point history
  // now comes from the documented price_history endpoint (not exercised here;
  // it is a credit-metered call gated behind Owner_Approval).
  it("writes ONLY the single real snapshot even when trend deltas are present", async () => {
    scrydexMock.resolveScrydexCard.mockResolvedValue(RESOLVED);
    scrydexMock.pickRawPrice.mockReturnValue({
      ...RAW,
      trends: {
        days_1: { price_change: -5 },
        days_7: { price_change: 10 },
        days_14: { price_change: 20 },
      },
    });

    await pullAndStoreScrydexPrice(CARD);

    // Exactly one createMany (the real snapshot) — no second trend-backfill call.
    expect(prismaMock.pricingHistory.createMany).toHaveBeenCalledTimes(1);
    const snapshotArg = prismaMock.pricingHistory.createMany.mock.calls[0][0];
    expect(snapshotArg.data.every((p: { source: string }) => p.source === "scrydex")).toBe(true);
    expect(
      snapshotArg.data.some((p: { source: string }) => p.source === "scrydex-trend")
    ).toBe(false);
  });
});
