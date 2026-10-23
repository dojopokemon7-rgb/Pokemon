import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

// Credit gate — toggled per test. `pullAndStoreScrydexPrice` now soft-gates at
// its TOP via `isScrydexLiveApproved` (sec-audit FIX A: close the ungated
// unauthenticated graded credit-spend path). Default APPROVED so the existing
// pull/gate/capture tests exercise the live path; the FIX A block flips it off.
const gateMock = vi.hoisted(() => ({ approved: true }));
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

// Mock the thin client so we control what a "pull" resolves to.
const scrydexMock = vi.hoisted(() => ({
  resolveScrydexCard: vi.fn(),
  fetchScrydexCardById: vi.fn(),
  pickRawPrice: vi.fn(),
  // Bug B: history-writer test needs the documented /price_history fetch.
  fetchScrydexPriceHistory: vi.fn(),
}));
vi.mock("@/lib/services/scrydex.service", () => scrydexMock);

import {
  pullAndStoreScrydexPrice,
  pullAndStoreScrydexHistory,
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
  gateMock.approved = true; // default: credits approved (restored per test)
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

  // Regression: Scrydex returns TWO entries that collapse to the SAME
  // (variant, condition, company, grade, type) identity — e.g. two "CGC 10"
  // graded entries (standard vs perfect at different market prices) under one
  // variant. The schema has no column to distinguish them. Before the dedupe
  // fix createMany threw a unique-constraint violation, the $transaction rolled
  // back, and ZERO prices were stored (the real "price FAIL" on me1-134 etc.).
  const COLLISION_CARD = {
    id: "me1-134",
    name: "Ivysaur",
    number: "134",
    variants: [
      {
        name: "holofoil",
        prices: [
          { type: "raw", condition: "NM", company: null, grade: null, market: 12, low: 10, currency: "USD" },
          // Two CGC 10 under the SAME variant → collide on the 8-column key.
          { type: "graded", condition: null, company: "CGC", grade: "10", market: 1500, low: 1400, currency: "USD" },
          { type: "graded", condition: null, company: "CGC", grade: "10", market: 1800, low: 1700, currency: "USD" },
          // A distinct other graded grade so the "all OTHER rows kept" check bites.
          { type: "graded", condition: null, company: "PSA", grade: "9", market: 400, low: 380, currency: "USD" },
        ],
      },
    ],
  };

  it("dedupes a colliding 8-column key — keeps the higher-market row, stores all other distinct rows, never throws", async () => {
    scrydexMock.resolveScrydexCard.mockResolvedValue({ scrydexId: "me1-134", card: COLLISION_CARD });
    scrydexMock.pickRawPrice.mockReturnValue(RAW);

    // Does NOT throw (pre-fix this rejected with a unique-constraint violation).
    await expect(pullAndStoreScrydexPrice(CARD, { force: true })).resolves.toBeDefined();

    const call = prismaMock.currentPrice.createMany.mock.calls[0][0];
    const rows = call.data;

    // Exactly ONE row for the colliding CGC-10/holofoil identity...
    const cgc10 = rows.filter(
      (r: { type: string; company: string | null; grade: string | null; variant: string }) =>
        r.type === "graded" && r.company === "CGC" && r.grade === "10" && r.variant === "holofoil"
    );
    expect(cgc10).toHaveLength(1);
    // ...and it is the HIGHER-market one (1800 beats 1500).
    expect(cgc10[0].priceMarket).toBe(1800);

    // All the OTHER distinct rows are still present.
    expect(rows).toContainEqual(
      expect.objectContaining({ type: "raw", condition: "NM", company: null, grade: null, variant: "holofoil" })
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ type: "graded", condition: "GRADED", company: "PSA", grade: "9", variant: "holofoil" })
    );

    // Belt-and-suspenders guard shipped on the createMany.
    expect(call).toEqual(expect.objectContaining({ skipDuplicates: true }));
  });
});

describe("pullAndStoreScrydexPrice — per-printing scope (Bug D)", () => {
  // The shared scrydexId returns EVERY sibling printing. The writer must store
  // ONLY the row's own printing (card.printing), or an alt-art/reverse row
  // inherits a sibling's prices (audit 14 F-14-07 / 01 P-08 / 09 F15).
  const TWO_PRINTING_CARD = {
    id: "me55c-4",
    name: "Charizard",
    number: "4",
    variants: [
      {
        name: "holofoil",
        prices: [
          { type: "raw", condition: "NM", company: null, grade: null, market: 100, low: 90, currency: "USD" },
          { type: "graded", condition: null, company: "PSA", grade: "10", market: 3200, low: 3000, currency: "USD" },
        ],
      },
      {
        name: "reverse-holofoil",
        prices: [
          { type: "raw", condition: "NM", company: null, grade: null, market: 55, low: 50, currency: "USD" },
          { type: "graded", condition: null, company: "PSA", grade: "10", market: 1200, low: 1100, currency: "USD" },
        ],
      },
    ],
  };

  it("stores ONLY the row's own printing's CurrentPrice rows (no sibling bleed)", async () => {
    scrydexMock.resolveScrydexCard.mockResolvedValue({ scrydexId: "me55c-4", card: TWO_PRINTING_CARD });
    // Real-ish pickRawPrice: echo the scoped card's first raw NM entry so the
    // history point / cost-basis reflect the SCOPED variant, not holofoil.
    scrydexMock.pickRawPrice.mockImplementation((c: { variants: Array<{ name: string; prices: Array<{ type: string; market: number; low: number; currency: string }> }> }) => {
      const v = c.variants[0];
      const p = v.prices.find((x) => x.type === "raw")!;
      return { market: p.market, low: p.low, currency: p.currency, trends: null, variant: v.name, condition: "NM" };
    });

    await pullAndStoreScrydexPrice(
      { ...CARD, printing: "reverse-holofoil" },
      { force: true }
    );

    const rows = prismaMock.currentPrice.createMany.mock.calls[0][0].data;
    // EVERY stored row is the reverse-holofoil printing — no holofoil bled in.
    expect(rows.every((r: { variant: string }) => r.variant === "reverse-holofoil")).toBe(true);
    expect(rows.some((r: { variant: string }) => r.variant === "holofoil")).toBe(false);

    // The raw history point used the reverse-holofoil raw (55), not holofoil (100).
    const histRow = prismaMock.pricingHistory.createMany.mock.calls[0][0].data[0];
    expect(histRow).toMatchObject({ priceMarket: 55, variant: "reverse-holofoil" });

    // Lazy cost-basis resolution used the scoped (reverse-holofoil) market.
    expect(prismaMock.userCollection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ purchasePrice: 55 }) })
    );
  });

  it("falls back to ALL variants when the printing is absent from the payload (never stores zero)", async () => {
    scrydexMock.resolveScrydexCard.mockResolvedValue({ scrydexId: "me55c-4", card: TWO_PRINTING_CARD });
    scrydexMock.pickRawPrice.mockReturnValue(RAW);

    await pullAndStoreScrydexPrice(
      { ...CARD, printing: "does-not-exist" },
      { force: true }
    );

    const rows = prismaMock.currentPrice.createMany.mock.calls[0][0].data;
    // Both printings present (fallback) — a mismatched printing never zeroes prices.
    const variants = [...new Set(rows.map((r: { variant: string }) => r.variant))].sort();
    expect(variants).toEqual(["holofoil", "reverse-holofoil"]);
  });

  it("defaults to the base 'normal' printing when card.printing is null", async () => {
    const BASE_CARD = {
      id: "me55c-4",
      name: "Charizard",
      number: "4",
      variants: [
        {
          name: "normal",
          prices: [
            { type: "raw", condition: "NM", company: null, grade: null, market: 40, low: 35, currency: "USD" },
          ],
        },
        {
          name: "reverse-holofoil",
          prices: [
            { type: "raw", condition: "NM", company: null, grade: null, market: 90, low: 80, currency: "USD" },
          ],
        },
      ],
    };
    scrydexMock.resolveScrydexCard.mockResolvedValue({ scrydexId: "me55c-4", card: BASE_CARD });
    scrydexMock.pickRawPrice.mockReturnValue(RAW);

    await pullAndStoreScrydexPrice({ ...CARD, printing: null }, { force: true });

    const rows = prismaMock.currentPrice.createMany.mock.calls[0][0].data;
    expect(rows.every((r: { variant: string }) => r.variant === "normal")).toBe(true);
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

describe("pullAndStoreScrydexPrice — credit gate (FIX A, sec-audit)", () => {
  // The ONLY credit-spending pull that used to lack a gate. With live credits
  // NOT approved it must be a clean no-op (fail-open, RULE 7): the no-op shape,
  // NO Scrydex fetch, NO price rows, NO SyncLog — so the unauthenticated graded
  // GET and portfolio refresh can't walk the catalog spending credits.
  it("returns the no-op shape and does NOT fetch Scrydex when credits are NOT approved", async () => {
    gateMock.approved = false;
    // Even with a wide-open freshness gate + a resolvable card, nothing fires.
    prismaMock.syncLog.findFirst.mockResolvedValue(null);
    scrydexMock.resolveScrydexCard.mockResolvedValue(RESOLVED);
    scrydexMock.fetchScrydexCardById.mockResolvedValue(RESOLVED.card);
    scrydexMock.pickRawPrice.mockReturnValue(RAW);

    const result = await pullAndStoreScrydexPrice(CARD);

    expect(result).toEqual({ pulled: false, credits: 0, card: null });
    expect(scrydexMock.fetchScrydexCardById).not.toHaveBeenCalled();
    expect(scrydexMock.resolveScrydexCard).not.toHaveBeenCalled();
    // Gate is BEFORE the freshness check — not even the SyncLog read happens.
    expect(prismaMock.syncLog.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.pricingHistory.createMany).not.toHaveBeenCalled();
    expect(prismaMock.syncLog.create).not.toHaveBeenCalled();
  });

  it("still no-ops under opts.force when credits are NOT approved (gate precedes force)", async () => {
    gateMock.approved = false;
    scrydexMock.resolveScrydexCard.mockResolvedValue(RESOLVED);
    scrydexMock.fetchScrydexCardById.mockResolvedValue(RESOLVED.card);

    const result = await pullAndStoreScrydexPrice(CARD, { force: true });

    expect(result).toEqual({ pulled: false, credits: 0, card: null });
    expect(scrydexMock.resolveScrydexCard).not.toHaveBeenCalled();
    expect(scrydexMock.fetchScrydexCardById).not.toHaveBeenCalled();
  });
});

describe("pullAndStoreScrydexPrice — Card.marketPrice mirror (BUG 1)", () => {
  // BUG 1 (user #7 + #2): the UI headline/raw price reads Card.marketPrice, but
  // this writer never wrote it — so marketPrice stayed STALE while the chart
  // (reads PricingHistory) and Scrydex said something else. The fix mirrors the
  // printing-scoped raw NM market price into Card.marketPrice (+ lastPricedAt),
  // and ONLY when raw.market is a real number (RULE 2 — never null/0).
  //
  // Helper: find the card.update call (if any) whose data carries a marketPrice
  // key. Other card.update calls fire for scrydexId caching + weekly-change, so
  // we must filter for the marketPrice write specifically.
  function marketPriceUpdateCall(): [{ where: { id: string }; data: Record<string, unknown> }] | undefined {
    return prismaMock.card.update.mock.calls.find((c: unknown[]) => {
      const arg = c[0] as { data?: Record<string, unknown> } | undefined;
      return arg?.data != null && Object.prototype.hasOwnProperty.call(arg.data, "marketPrice");
    }) as [{ where: { id: string }; data: Record<string, unknown> }] | undefined;
  }

  it("(a) a fresh priced pull writes Card.marketPrice = raw NM market + a lastPricedAt Date", async () => {
    scrydexMock.resolveScrydexCard.mockResolvedValue(RESOLVED);
    scrydexMock.pickRawPrice.mockReturnValue(RAW); // RAW.market === 191.34

    await pullAndStoreScrydexPrice(CARD);

    const call = marketPriceUpdateCall();
    expect(call).toBeDefined();
    expect(call![0]).toEqual(
      expect.objectContaining({
        where: { id: CARD.id },
        data: expect.objectContaining({ marketPrice: 191.34 }),
      })
    );
    expect(call![0].data.lastPricedAt).toBeInstanceOf(Date);
  });

  it("(b) a graded-only pull (no raw price) does NOT write marketPrice (RULE 2 — unchanged)", async () => {
    scrydexMock.resolveScrydexCard.mockResolvedValue(RESOLVED);
    scrydexMock.pickRawPrice.mockReturnValue(null); // graded-only / no raw NM

    await pullAndStoreScrydexPrice(CARD);

    // No card.update carries a marketPrice key (scrydexId cache may still fire).
    expect(marketPriceUpdateCall()).toBeUndefined();
  });

  it("(c) a raw with market=null (low-only) does NOT write marketPrice (RULE 2 — never null/0)", async () => {
    scrydexMock.resolveScrydexCard.mockResolvedValue(RESOLVED);
    scrydexMock.pickRawPrice.mockReturnValue({ ...RAW, market: null }); // low-only raw

    await pullAndStoreScrydexPrice(CARD);

    expect(marketPriceUpdateCall()).toBeUndefined();
  });

  it("(d) printing-scoped: the scoped printing's raw NM is written, never a sibling's (RULE 3)", async () => {
    // Two printings share one scrydexId; pickRawPrice is scoped to the requested
    // printing. Asserting the WRITTEN marketPrice is the reverse-holofoil raw (55)
    // and never the holofoil sibling (100) pins the printing scoping.
    const TWO_PRINTING_CARD = {
      id: "me55c-4",
      name: "Charizard",
      number: "4",
      variants: [
        {
          name: "holofoil",
          prices: [{ type: "raw", condition: "NM", company: null, grade: null, market: 100, low: 90, currency: "USD" }],
        },
        {
          name: "reverse-holofoil",
          prices: [{ type: "raw", condition: "NM", company: null, grade: null, market: 55, low: 50, currency: "USD" }],
        },
      ],
    };
    scrydexMock.resolveScrydexCard.mockResolvedValue({ scrydexId: "me55c-4", card: TWO_PRINTING_CARD });
    // pickRawPrice echoes the SCOPED card's first raw NM entry (scope applied upstream).
    scrydexMock.pickRawPrice.mockImplementation(
      (c: { variants: Array<{ name: string; prices: Array<{ type: string; market: number; low: number; currency: string }> }> }) => {
        const v = c.variants[0];
        const p = v.prices.find((x) => x.type === "raw")!;
        return { market: p.market, low: p.low, currency: p.currency, trends: null, variant: v.name, condition: "NM" };
      }
    );

    await pullAndStoreScrydexPrice({ ...CARD, printing: "reverse-holofoil" }, { force: true });

    const call = marketPriceUpdateCall();
    expect(call).toBeDefined();
    expect(call![0].data.marketPrice).toBe(55); // scoped variant's raw NM, NOT holofoil's 100
  });
});

describe("pullAndStoreScrydexPrice — on-view credit auth (BUG 2)", () => {
  // BUG 2 (user #8): the soft top gate now honours on-view authorization so the
  // portfolio refresh (which passes creditAuth:"onview") works in staging/prod
  // that enable ONLY SCRYDEX_ONVIEW_ENABLED. With the bulk gate OFF, an on-view
  // caller must still run; both flags off stays a clean no-op (dev DENY).
  afterEach(() => {
    delete process.env.SCRYDEX_ONVIEW_ENABLED;
  });

  it("runs the pull on creditAuth:'onview' when the on-view flag is on but bulk is off", async () => {
    gateMock.approved = false; // bulk gate OFF
    process.env.SCRYDEX_ONVIEW_ENABLED = "true"; // on-view ON
    scrydexMock.resolveScrydexCard.mockResolvedValue(RESOLVED);
    scrydexMock.pickRawPrice.mockReturnValue(RAW);

    const result = await pullAndStoreScrydexPrice(CARD, { creditAuth: "onview" });

    expect(result.pulled).toBe(true);
    expect(scrydexMock.resolveScrydexCard).toHaveBeenCalled();
  });

  it("stays a no-op when BOTH gates are off even with creditAuth:'onview' (dev DENY)", async () => {
    gateMock.approved = false; // bulk OFF
    // SCRYDEX_ONVIEW_ENABLED unset → on-view OFF
    scrydexMock.resolveScrydexCard.mockResolvedValue(RESOLVED);

    const result = await pullAndStoreScrydexPrice(CARD, { creditAuth: "onview" });

    expect(result).toEqual({ pulled: false, credits: 0, card: null });
    expect(scrydexMock.resolveScrydexCard).not.toHaveBeenCalled();
  });
});

describe("pullAndStoreScrydexHistory — raw per-day identity (Bug B)", () => {
  // The raw-only partial unique index `ph_raw_coalesced` (authored in
  // 20250113000000_pricing_history_raw_dedupe) relies on the history writer
  // keying every raw NM point to UTC MIDNIGHT of its Scrydex day and writing
  // with skipDuplicates. These assertions pin that per-day contract (the index
  // itself is DB-level and not unit-testable without a live DB — see APPLY.md).
  //
  // We authorize via the ON-VIEW gate (creditAuth:"onview" + flag) so the test
  // is independent of the bulk-gate mock in this file.
  const HISTORY_SCRYDEX_ID = "me55c-4";

  afterEach(() => {
    delete process.env.SCRYDEX_ONVIEW_ENABLED;
  });

  it("stores raw NM points at UTC midnight with company/grade null + skipDuplicates", async () => {
    process.env.SCRYDEX_ONVIEW_ENABLED = "true";
    scrydexMock.fetchScrydexPriceHistory.mockResolvedValue([
      {
        date: "2026/10/03",
        prices: [
          { type: "raw", condition: "NM", market: 100, low: 90, currency: "USD", variant: "normal" },
        ],
      },
      {
        date: "2026/10/04",
        prices: [
          { type: "raw", condition: "NM", market: 110, low: 95, currency: "USD", variant: "normal" },
          // Non-raw / non-NM entries are filtered out (RAW NM series only).
          { type: "graded", condition: null, market: 999, low: null, currency: "USD", variant: "normal" },
          { type: "raw", condition: "LP", market: 80, low: null, currency: "USD", variant: "normal" },
        ],
      },
    ]);

    const result = await pullAndStoreScrydexHistory(
      { id: CARD.id, game: Game.POKEMON, scrydexId: HISTORY_SCRYDEX_ID },
      { days: 365, creditAuth: "onview" }
    );

    expect(result.stored).toBe(2); // two raw NM days; graded + LP filtered out

    const call = prismaMock.pricingHistory.createMany.mock.calls[0][0];
    expect(call.skipDuplicates).toBe(true); // index relies on skipDuplicates
    const rows = call.data;
    expect(rows).toHaveLength(2);

    // Every stored raw row: UTC midnight recordedAt (the per-day index key),
    // null-free raw identity (company/grade absent), source scrydex.
    for (const r of rows) {
      expect(r.recordedAt.toISOString()).toBe(
        `${r.recordedAt.toISOString().slice(0, 10)}T00:00:00.000Z`
      );
      expect(r.company ?? null).toBeNull();
      expect(r.grade ?? null).toBeNull();
      expect(r.source).toBe("scrydex");
      expect(r.condition).toBe("NM");
    }
    expect(rows.map((r: { recordedAt: Date }) => r.recordedAt.toISOString()).sort()).toEqual([
      "2026-10-03T00:00:00.000Z",
      "2026-10-04T00:00:00.000Z",
    ]);
  });
});
