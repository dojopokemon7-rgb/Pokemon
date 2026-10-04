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
  // C1: the full-capture pass REPLACES the SCRYDEX price set atomically —
  // deleteMany (source-scoped) + createMany inside a $transaction.
  currentPrice: { deleteMany: vi.fn(), createMany: vi.fn() },
  // $transaction runs its ops; we just resolve so the writer proceeds.
  $transaction: vi.fn(async (ops: unknown) => (Array.isArray(ops) ? ops : [])),
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
  card: {
    id: "me55c-4",
    name: "Charizard",
    number: "4",
    // C1: the full-capture loop iterates variants[].prices[]. One raw NM entry
    // so the CurrentPrice upsert fires (the headline NM row the loop captures).
    variants: [
      {
        name: "holofoil",
        prices: [
          { type: "raw", condition: "NM", company: null, grade: null, market: 191.34, low: 170, currency: "USD" },
        ],
      },
    ],
  },
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
  prismaMock.currentPrice.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.currentPrice.createMany.mockResolvedValue({ count: 0 });
  prismaMock.$transaction.mockImplementation(async (ops: unknown) => (Array.isArray(ops) ? ops : []));
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

    // C1: the SCRYDEX price set is replaced atomically — deleteMany is
    // source-scoped (never touches non-Scrydex rows), createMany writes the
    // fresh set. The raw NM entry is a row with null company/grade + type 'raw'.
    expect(prismaMock.currentPrice.deleteMany).toHaveBeenCalledWith({
      where: { cardId: CARD.id, source: DataSource.SCRYDEX },
    });
    const createArg = prismaMock.currentPrice.createMany.mock.calls[0][0];
    expect(createArg.data).toContainEqual(
      expect.objectContaining({
        cardId: CARD.id,
        source: DataSource.SCRYDEX,
        currency: "USD",
        variant: "holofoil",
        condition: "NM",
        company: null,
        grade: null,
        type: "raw",
      })
    );

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
    expect(prismaMock.currentPrice.createMany).not.toHaveBeenCalled();
    expect(prismaMock.currentPrice.deleteMany).not.toHaveBeenCalled();
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

describe("pullAndStoreScrydexPrice — C1 full current-price capture", () => {
  // C1: persist EVERY variants[].prices[] entry as its own CurrentPrice row on
  // the widened 8-column key. The loop iterates scrydexCard.variants, which is
  // only non-null on the fresh-fetch path — so this test drives past the
  // freshness gate via opts:{force:true}. pickRawPrice stays mocked (headline
  // NM raw) but is independent of the full-capture loop.
  const MULTI_CARD = {
    id: "me55c-4",
    name: "Charizard",
    number: "4",
    variants: [
      {
        name: "holofoil",
        prices: [
          { type: "raw", condition: "NM", company: null, grade: null, market: 191.34, low: 170, currency: "USD" },
          { type: "raw", condition: "LP", company: null, grade: null, market: 150, low: 140, currency: "USD" },
          { type: "raw", condition: "MP", company: null, grade: null, market: 120, low: null, currency: "USD" },
          { type: "raw", condition: "HP", company: null, grade: null, market: null, low: 90, currency: "USD" },
          { type: "graded", condition: null, company: "psa", grade: "10", market: 3200, low: 3000, currency: "USD" },
          { type: "graded", condition: null, company: "PSA", grade: "9", market: 1100, low: 1000, currency: "USD" },
          { type: "graded", condition: null, company: "PSA", grade: "8.5", market: 600, low: null, currency: "USD" },
          { type: "graded", condition: null, company: "PSA", grade: "9Q", market: 850, low: null, currency: "USD" },
          { type: "graded", condition: null, company: "cgc", grade: "9.5", market: 900, low: null, currency: "USD" },
          { type: "graded", condition: null, company: "PSA", grade: "7", market: null, low: null, currency: "USD" }, // both-null → skipped
        ],
      },
      {
        name: "reverse-holofoil",
        prices: [
          // Same PSA-10 grade under a DIFFERENT variant → a DISTINCT row.
          { type: "graded", condition: null, company: "PSA", grade: "10", market: 2800, low: 2600, currency: "USD" },
        ],
      },
    ],
  };

  it("createMany writes one row per non-null entry (raw conds + graded company/grade)", async () => {
    scrydexMock.resolveScrydexCard.mockResolvedValue({ scrydexId: "me55c-4", card: MULTI_CARD });
    scrydexMock.pickRawPrice.mockReturnValue(RAW);

    await pullAndStoreScrydexPrice(CARD, { force: true });

    const rows = prismaMock.currentPrice.createMany.mock.calls[0][0].data;

    // 11 entries (10 holofoil + 1 reverse-holofoil) - 1 both-null skip = 10 rows.
    expect(rows).toHaveLength(10);

    // Raw NM row: real condition, null company/grade, type 'raw'.
    expect(rows).toContainEqual(
      expect.objectContaining({
        cardId: CARD.id, source: DataSource.SCRYDEX, currency: "USD",
        variant: "holofoil", condition: "NM", company: null, grade: null, type: "raw",
      })
    );
    // All four raw conditions present.
    expect(
      rows.filter((r: { type: string }) => r.type === "raw").map((r: { condition: string }) => r.condition).sort()
    ).toEqual(["HP", "LP", "MP", "NM"]);

    // Graded rows: sentinel condition 'GRADED', uppercased company, verbatim grade.
    expect(rows).toContainEqual(
      expect.objectContaining({
        type: "graded", condition: "GRADED", company: "PSA", grade: "10", variant: "holofoil",
      })
    );
    // Verbatim half / qualified grades preserved.
    expect(rows.some((r: { grade: string | null }) => r.grade === "8.5")).toBe(true);
    expect(rows.some((r: { grade: string | null }) => r.grade === "9Q")).toBe(true);
    // Lower-cased company upper-cased on the stored row.
    expect(rows.some((r: { company: string | null; grade: string | null }) => r.company === "CGC" && r.grade === "9.5")).toBe(true);

    // both-null PSA 7 entry skipped (never a fabricated $0).
    expect(rows.some((r: { grade: string | null }) => r.grade === "7")).toBe(false);

    // Two PSA-10 under DIFFERENT variants → two distinct rows.
    const psa10s = rows.filter((r: { type: string; grade: string | null }) => r.type === "graded" && r.grade === "10");
    expect(psa10s.map((r: { variant: string }) => r.variant).sort()).toEqual(["holofoil", "reverse-holofoil"]);
  });

  it("replaces the set atomically — source-scoped deleteMany + createMany in a $transaction", async () => {
    scrydexMock.resolveScrydexCard.mockResolvedValue({ scrydexId: "me55c-4", card: MULTI_CARD });
    scrydexMock.pickRawPrice.mockReturnValue(RAW);

    await pullAndStoreScrydexPrice(CARD, { force: true });

    // deleteMany is scoped to source=SCRYDEX so non-Scrydex rows are untouched.
    expect(prismaMock.currentPrice.deleteMany).toHaveBeenCalledWith({
      where: { cardId: CARD.id, source: DataSource.SCRYDEX },
    });
    // Both writes went through $transaction (atomic replace).
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
  });

  it("writes market/low on each row and keeps a market-only entry's low null (no fabricated $0)", async () => {
    scrydexMock.resolveScrydexCard.mockResolvedValue({ scrydexId: "me55c-4", card: MULTI_CARD });
    scrydexMock.pickRawPrice.mockReturnValue(RAW);

    await pullAndStoreScrydexPrice(CARD, { force: true });

    const rows = prismaMock.currentPrice.createMany.mock.calls[0][0].data;
    const mp = rows.find((r: { condition: string }) => r.condition === "MP");
    // MP had market=120, low=null → stored verbatim, low stays null.
    expect(mp).toMatchObject({ priceMarket: 120, priceLow: null });
  });

  it("is idempotent — a repeat persist replaces, never grows the set", async () => {
    scrydexMock.resolveScrydexCard.mockResolvedValue({ scrydexId: "me55c-4", card: MULTI_CARD });
    scrydexMock.pickRawPrice.mockReturnValue(RAW);

    await pullAndStoreScrydexPrice(CARD, { force: true });
    const firstRows = prismaMock.currentPrice.createMany.mock.calls[0][0].data.length;

    await pullAndStoreScrydexPrice(CARD, { force: true });
    const secondRows = prismaMock.currentPrice.createMany.mock.calls[1][0].data.length;
    // Each pull deletes then writes the SAME full set — the row count is stable.
    expect(secondRows).toBe(firstRows);
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
