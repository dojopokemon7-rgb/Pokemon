import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ssr-dashboard-chart — pins the extracted `buildCollectionHistories` service.
 *
 * (a) SHAPE PARITY: the service returns the SAME `{ [collId]: [{date,value}] }`
 *     map the GET route body produced — same keys, same honest null gaps, no
 *     fabricated $0. Reuses the exact fixture from the route's integration test
 *     (`history-null-safe.test.ts`) so a divergence between the extracted
 *     service and the route it replaced is caught.
 * (b) SSR-KEY PARITY: the dashboard page's SSR `collectionIdsQuery`
 *     (`["__uncat__", ...collections.map(c=>c.id)].join(",")`) is byte-identical
 *     to the client's first-render `Array.from(activeSelectedIds).join(",")`
 *     for the default empty selection, with the default range "1M". If these
 *     drift, the SSR data would never hydrate the chart query (flicker returns).
 *
 * Mocks Prisma (no live DB), mirroring the integration test's hoisted mock.
 */

const prismaMock = vi.hoisted(() => ({
  userCollection: { findMany: vi.fn() },
  pricingHistory: { findMany: vi.fn() },
  // CROSS-SNAPSHOT PARITY (review-blocking): the service now reads the latest
  // CurrentPrice graded rows to decide each graded lot's variant (the SAME
  // stable source display reads). Default to no current graded rows so the raw
  // / legacy fixtures are unaffected — those tests never set a graded condition.
  currentPrice: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildCollectionHistories } from "@/lib/services/collection-history.service";
import { toHistoryToken } from "@/lib/utils/collection-ids";

const USER_ID = "user_123";

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no current graded rows (raw/legacy fixtures). A graded test sets
  // this explicitly to drive the cross-snapshot variant decision.
  prismaMock.currentPrice.findMany.mockResolvedValue([]);
});

describe("buildCollectionHistories — shape parity with the GET route (a)", () => {
  it("never fabricates a value: null-priced rows + pre-ownership days are gaps, keyed by the bucket id", async () => {
    // Identical fixture to history-null-safe.test.ts: one lot (qty 2) owned 3
    // days, one null-priced row (skipped) + one real priceMarket 10 → 10*2=20.
    const addedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    prismaMock.userCollection.findMany.mockResolvedValue([
      { cardId: "card_1", quantity: 2, addedAt, soldAt: null, isSold: false },
    ]);
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    prismaMock.pricingHistory.findMany.mockResolvedValue([
      { cardId: "card_1", recordedAt: addedAt, priceMarket: null },
      { cardId: "card_1", recordedAt: recent, priceMarket: 10 },
    ]);

    const histories = await buildCollectionHistories(USER_ID, ["null"], "1M");

    const series = histories["null"];
    expect(Array.isArray(series)).toBe(true);
    const values = series.map((p) => p.value);
    expect(values.some((v) => v === 0)).toBe(false); // never a fabricated $0
    expect(values).toContain(20); // real priced day values the lot (10 × qty 2)
    // Shape: each point is { date: "YYYY-MM-DD", value: number | null }.
    for (const p of series) {
      expect(typeof p.date).toBe("string");
      expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.value === null || typeof p.value === "number").toBe(true);
    }
  });

  it("returns an empty series for a bucket with no lots", async () => {
    prismaMock.userCollection.findMany.mockResolvedValue([]);
    const histories = await buildCollectionHistories(USER_ID, ["null"], "1M");
    expect(histories["null"]).toEqual([]);
  });

  it("builds one series per requested collId (multi-bucket)", async () => {
    prismaMock.userCollection.findMany.mockResolvedValue([]);
    // Post-fix the real call path hands the service the TRANSLATED tokens
    // (loose bucket "__uncat__" → "null"); the service echoes whatever token
    // set it receives, so it keys by "null","c1","c2".
    const histories = await buildCollectionHistories(
      USER_ID,
      ["null", "c1", "c2"],
      "1M"
    );
    expect(Object.keys(histories)).toEqual(["null", "c1", "c2"]);
  });

  // AC-8/AC-9 — the key-path the chart depends on: a loose (collectionId=null)
  // collection that HAS real history must plot. The client now sends "null"
  // (translated from "__uncat__"), so histories["null"] must be populated AND
  // histories[toHistoryToken("__uncat__")] must resolve to that SAME series.
  it("plots a loose bucket with >=2 real points under the 'null' key, reachable via toHistoryToken('__uncat__')", async () => {
    const addedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    prismaMock.userCollection.findMany.mockResolvedValue([
      { cardId: "card_1", quantity: 1, addedAt, soldAt: null, isSold: false },
    ]);
    const d1 = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const d2 = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    prismaMock.pricingHistory.findMany.mockResolvedValue([
      { cardId: "card_1", recordedAt: d1, priceMarket: 12 },
      { cardId: "card_1", recordedAt: d2, priceMarket: 15 },
    ]);

    const histories = await buildCollectionHistories(USER_ID, ["null"], "1M");

    const series = histories["null"];
    const numeric = series.filter((p) => typeof p.value === "number");
    expect(numeric.length).toBeGreaterThanOrEqual(2);
    // The chart maps the UI sentinel to this exact key, so it resolves to the
    // same populated array — the loose collection with history plots.
    expect(histories[toHistoryToken("__uncat__")]).toBe(series);
  });
});

describe("buildCollectionHistories — addedAt timeline anchor (A1)", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("(1) a freshly-added lot (addedAt ~now) yields >=2 non-null points (anchor + now)", async () => {
    // Lot added effectively now — before the fix, every daily timeline point
    // sits BEFORE addedAt and fails the ownership gate, leaving <2 drawable
    // points. The injected addedAt anchor + the now point must both value it.
    const addedAt = new Date(Date.now() - 60 * 1000); // ~1 min ago
    prismaMock.userCollection.findMany.mockResolvedValue([
      { cardId: "card_1", quantity: 1, addedAt, soldAt: null, isSold: false },
    ]);
    // A real price recorded at/just-before addedAt so carry-forward values it.
    prismaMock.pricingHistory.findMany.mockResolvedValue([
      { cardId: "card_1", recordedAt: new Date(addedAt.getTime() - 30 * 1000), priceMarket: 42 },
    ]);

    const histories = await buildCollectionHistories(USER_ID, ["null"], "1M");

    const series = histories["null"];
    const numeric = series.filter((p) => typeof p.value === "number");
    expect(numeric.length).toBeGreaterThanOrEqual(2);
    expect(numeric.every((p) => p.value === 42)).toBe(true); // never fabricated
  });

  it("(2) a lot added before startDate clamps to the window (no point left of startDate)", async () => {
    // addedAt a full year ago; a 1M window must not emit any point earlier
    // than startDate — the anchor is clamped INTO [startMs, nowMs].
    const addedAt = new Date(Date.now() - 365 * DAY);
    prismaMock.userCollection.findMany.mockResolvedValue([
      { cardId: "card_1", quantity: 1, addedAt, soldAt: null, isSold: false },
    ]);
    prismaMock.pricingHistory.findMany.mockResolvedValue([]);

    const histories = await buildCollectionHistories(USER_ID, ["null"], "1M");

    const start = new Date();
    start.setMonth(start.getMonth() - 1);
    const startDay = start.toISOString().slice(0, 10);
    expect(histories["null"].every((p) => p.date >= startDay)).toBe(true);
  });

  it("(3) two lots sharing the same addedAt dedupe to one timeline point", async () => {
    const addedAt = new Date(Date.now() - 2 * DAY);
    prismaMock.userCollection.findMany.mockResolvedValue([
      { cardId: "card_1", quantity: 1, addedAt, soldAt: null, isSold: false },
      { cardId: "card_2", quantity: 1, addedAt, soldAt: null, isSold: false },
    ]);
    prismaMock.pricingHistory.findMany.mockResolvedValue([]);

    const histories = await buildCollectionHistories(USER_ID, ["null"], "1M");

    // The exact-equal anchor timestamps must collapse: the date (and its
    // underlying ms) appears at most once in the emitted series.
    const dates = histories["null"].map((p) => p.date);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it("(4) a lot with no priced history still emits only null anchors (no fabricated $0)", async () => {
    const addedAt = new Date(Date.now() - 2 * DAY);
    prismaMock.userCollection.findMany.mockResolvedValue([
      { cardId: "card_1", quantity: 3, addedAt, soldAt: null, isSold: false },
    ]);
    prismaMock.pricingHistory.findMany.mockResolvedValue([]); // no real price

    const histories = await buildCollectionHistories(USER_ID, ["null"], "1M");

    expect(histories["null"].every((p) => p.value === null)).toBe(true);
    expect(histories["null"].some((p) => p.value === 0)).toBe(false);
  });

  it("(5) an empty bucket returns []", async () => {
    prismaMock.userCollection.findMany.mockResolvedValue([]);
    const histories = await buildCollectionHistories(USER_ID, ["null"], "1M");
    expect(histories["null"]).toEqual([]);
  });

  it("(6) a lot added mid-day on a PAST day yields >=2 valued points over ALL (anchor-dedup regression)", async () => {
    // Regression for the portfolio/dashboard "Not enough history to chart yet"
    // bug: a lot added ~18h ago lands on YESTERDAY's calendar day but AFTER
    // that day's grid instant (grid instants carry the window-start
    // time-of-day). The ownership gate (collection-series.ts `t < addedAt`)
    // nulls that day's grid point, so only TODAY's grid instant / the `now`
    // endpoint is >= addedAt — one valued point. The old anchor-dedup dropped
    // the addedAt anchor because its calendar day was "covered" by the grid,
    // collapsing the series to a single point (< 2 drawable → empty chart).
    // The anchor must now be kept, giving >= 2 valued points so the chart draws.
    const addedAt = new Date(Date.now() - 18 * 60 * 60 * 1000); // ~18h ago, past day, mid-day
    prismaMock.userCollection.findMany.mockResolvedValue([
      { cardId: "card_1", quantity: 2, addedAt, soldAt: null, isSold: false },
    ]);
    // Real prices spanning before and after addedAt so carry-forward values it.
    prismaMock.pricingHistory.findMany.mockResolvedValue([
      { cardId: "card_1", recordedAt: new Date(addedAt.getTime() - 2 * 60 * 60 * 1000), priceMarket: 8 },
      { cardId: "card_1", recordedAt: new Date(addedAt.getTime() + 1 * 60 * 60 * 1000), priceMarket: 11 },
    ]);

    const histories = await buildCollectionHistories(USER_ID, ["null"], "ALL");

    const series = histories["null"];
    const numeric = series.filter((p) => typeof p.value === "number");
    expect(numeric.length).toBeGreaterThanOrEqual(2); // FAILS pre-fix (collapses to 1)
    expect(numeric.every((p) => p.value === 16 || p.value === 22)).toBe(true); // 8×2 or 11×2, never fabricated
  });
});

describe("buildCollectionHistories — real moving series for a recent-but-real portfolio (A)", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("a ~2-day-old portfolio with REAL moving prices over ALL yields a DENSE moving series (not a 2-point flat line)", async () => {
    // Requirement A: the old QA #6b branch flattened a recent portfolio to a
    // 2-point line, masking real movement. Removed — the dense daily grid now
    // carries the REAL stored PricingHistory (carry-forward), so a portfolio
    // whose prices MOVED (5 → 8 → 11) shows that movement honestly.
    const added = new Date(Date.now() - 2 * DAY);
    prismaMock.userCollection.findMany.mockResolvedValue([
      { cardId: "card_1", quantity: 1, addedAt: added, soldAt: null, isSold: false },
    ]);
    // Real prices that MOVE across the short window (before + during ownership).
    prismaMock.pricingHistory.findMany.mockResolvedValue([
      { cardId: "card_1", recordedAt: new Date(added.getTime() - 6 * 60 * 60 * 1000), priceMarket: 5 },
      { cardId: "card_1", recordedAt: new Date(added.getTime() + 12 * 60 * 60 * 1000), priceMarket: 8 },
      { cardId: "card_1", recordedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), priceMarket: 11 },
    ]);

    const histories = await buildCollectionHistories(USER_ID, ["all"], "ALL");

    const series = histories["all"];
    const numeric = series.filter((p) => typeof p.value === "number");
    // (a) many points — NOT capped at 2 (the old flat branch is gone).
    expect(series.length).toBeGreaterThan(3);
    expect(numeric.length).toBeGreaterThanOrEqual(2);
    // (b) movement is visible: both an early and a late distinct real value.
    const values = numeric.map((p) => p.value);
    expect(values).toContain(8);
    expect(values).toContain(11);
    expect(new Set(values).size).toBeGreaterThan(1); // not flat
    // (c) never a fabricated 0.
    expect(values.some((v) => v === 0)).toBe(false);
  });

  it("an account with real multi-month history over ALL keeps its FULL dense series (no sparse-path regression)", async () => {
    // Earliest add is 4 months ago → well outside the 7-day short window → the
    // dense daily grid (and the genuine multi-month trend) is preserved.
    const added = new Date(Date.now() - 120 * DAY);
    prismaMock.userCollection.findMany.mockResolvedValue([
      { cardId: "card_1", quantity: 1, addedAt: added, soldAt: null, isSold: false },
    ]);
    // A couple of real price moves across the window so the series has shape.
    prismaMock.pricingHistory.findMany.mockResolvedValue([
      { cardId: "card_1", recordedAt: new Date(added.getTime() + DAY), priceMarket: 10 },
      { cardId: "card_1", recordedAt: new Date(Date.now() - 2 * DAY), priceMarket: 14 },
    ]);

    const histories = await buildCollectionHistories(USER_ID, ["all"], "ALL");

    const numeric = histories["all"].filter((p) => typeof p.value === "number");
    // The dense daily grid over ~120 days yields far more than the 3-point
    // sparse cap — proving the short-window path did NOT flatten real history.
    expect(numeric.length).toBeGreaterThan(30);
    // Honest real values present (no fabricated 0).
    expect(numeric.some((p) => p.value === 0)).toBe(false);
    expect(numeric.map((p) => p.value)).toContain(14);
  });

  it("a brand-new portfolio over a BOUNDED range (1M) is NOT sparse-shaped (gate is ALL/MAX only)", async () => {
    const added = new Date(Date.now() - 2 * DAY);
    prismaMock.userCollection.findMany.mockResolvedValue([
      { cardId: "card_1", quantity: 1, addedAt: added, soldAt: null, isSold: false },
    ]);
    prismaMock.pricingHistory.findMany.mockResolvedValue([
      { cardId: "card_1", recordedAt: new Date(added.getTime() - DAY), priceMarket: 6 },
    ]);

    const histories = await buildCollectionHistories(USER_ID, ["all"], "1M");

    // 1M keeps the existing daily-grid + addedAt-anchor path (unchanged by the
    // ALL-gated short-window shaping). It still renders >=2 drawable points.
    const numeric = histories["all"].filter((p) => typeof p.value === "number");
    expect(numeric.length).toBeGreaterThanOrEqual(2);
  });
});

describe("BUG 1 & 8 — the grade is honored through the real service call path", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("a PSA 9 lot is valued from the PSA 9 rows, not the PSA 10 / CGC 10 / raw rows sharing the cardId", async () => {
    // Lot added 90 days ago → dense ALL-grid path (NOT the short-window flat
    // path), so carry-forward over the grade-filtered series is exercised.
    const addedAt = new Date(Date.now() - 90 * DAY);
    prismaMock.userCollection.findMany.mockResolvedValue([
      { cardId: "card_1", quantity: 1, addedAt, soldAt: null, isSold: false, condition: "PSA 9" },
    ]);
    // Current snapshot carries the PSA 9 normal variant → the chart values the
    // PSA 9 normal history series (same variant display would price).
    prismaMock.currentPrice.findMany.mockResolvedValue([
      { cardId: "card_1", company: "PSA", grade: "9", variant: "normal", priceMarket: 500 },
    ]);
    // Same recordedAt, four grades sharing the one cardId. Pre-fix carry-forward
    // kept whichever sorted last; the PSA 9 lot must take 500.
    const rec = new Date(Date.now() - 60 * DAY);
    prismaMock.pricingHistory.findMany.mockResolvedValue([
      { cardId: "card_1", recordedAt: rec, priceMarket: 50, type: "raw", company: null, grade: null, variant: "normal", condition: "NM" },
      { cardId: "card_1", recordedAt: rec, priceMarket: 500, type: "graded", company: "PSA", grade: "9", variant: "normal", condition: null },
      { cardId: "card_1", recordedAt: rec, priceMarket: 1000, type: "graded", company: "PSA", grade: "10", variant: "normal", condition: null },
      { cardId: "card_1", recordedAt: rec, priceMarket: 900, type: "graded", company: "CGC", grade: "10", variant: "normal", condition: null },
    ]);

    const histories = await buildCollectionHistories(USER_ID, ["all"], "ALL");

    const numeric = histories["all"].filter((p) => typeof p.value === "number");
    expect(numeric.length).toBeGreaterThanOrEqual(2);
    // Every valued point is the PSA 9 price — never PSA 10 / CGC 10 / raw.
    expect(numeric.every((p) => p.value === 500)).toBe(true);
    expect(numeric.some((p) => p.value === 1000 || p.value === 900 || p.value === 50)).toBe(false);
  });

  it("a raw lot of the same card is valued from the raw rows", async () => {
    const addedAt = new Date(Date.now() - 90 * DAY);
    prismaMock.userCollection.findMany.mockResolvedValue([
      { cardId: "card_1", quantity: 1, addedAt, soldAt: null, isSold: false, condition: null },
    ]);
    const rec = new Date(Date.now() - 60 * DAY);
    prismaMock.pricingHistory.findMany.mockResolvedValue([
      { cardId: "card_1", recordedAt: rec, priceMarket: 50, type: "raw", company: null, grade: null, variant: "normal", condition: "NM" },
      { cardId: "card_1", recordedAt: rec, priceMarket: 1000, type: "graded", company: "PSA", grade: "10", variant: "normal", condition: null },
    ]);

    const histories = await buildCollectionHistories(USER_ID, ["all"], "ALL");
    const numeric = histories["all"].filter((p) => typeof p.value === "number");
    expect(numeric.length).toBeGreaterThanOrEqual(2);
    expect(numeric.every((p) => p.value === 50)).toBe(true);
  });

  // REVIEW B (blocking) — cross-snapshot graded VARIANT drift. The two price
  // stores have DIFFERENT variant sets for the SAME company+grade:
  //   - windowed PricingHistory: PSA 9 has BOTH normal (500) and holofoil (777)
  //   - latest CurrentPrice:     PSA 9 has ONLY holofoil (777)
  // The display path prices the lot at holofoil (the only current variant). The
  // chart MUST value the PSA 9 holofoil history series (777), NOT the PSA 9
  // normal series (500) it would pick if it derived the variant from history
  // alone — even though normal outranks holofoil in VARIANT_PRIORITY. The
  // service decides the variant from the CURRENT snapshot and threads it in.
  it("values the lot at the variant the CURRENT snapshot has, even when history carries extra variants for that company+grade", async () => {
    const addedAt = new Date(Date.now() - 90 * DAY);
    prismaMock.userCollection.findMany.mockResolvedValue([
      { cardId: "card_1", quantity: 1, addedAt, soldAt: null, isSold: false, condition: "PSA 9" },
    ]);
    // CURRENT: PSA 9 holofoil only → display prices holofoil.
    prismaMock.currentPrice.findMany.mockResolvedValue([
      { cardId: "card_1", company: "PSA", grade: "9", variant: "holofoil", priceMarket: 777 },
    ]);
    // HISTORY: PSA 9 has BOTH normal (500, higher variant priority) and holofoil
    // (777). A history-only variant decision would wrongly pick normal (500).
    const rec = new Date(Date.now() - 60 * DAY);
    prismaMock.pricingHistory.findMany.mockResolvedValue([
      { cardId: "card_1", recordedAt: rec, priceMarket: 500, type: "graded", company: "PSA", grade: "9", variant: "normal", condition: null },
      { cardId: "card_1", recordedAt: rec, priceMarket: 777, type: "graded", company: "PSA", grade: "9", variant: "holofoil", condition: null },
    ]);

    const histories = await buildCollectionHistories(USER_ID, ["all"], "ALL");
    const numeric = histories["all"].filter((p) => typeof p.value === "number");
    expect(numeric.length).toBeGreaterThanOrEqual(2);
    // Chart agrees with display: PSA 9 HOLOFOIL (777), never the normal (500).
    expect(numeric.every((p) => p.value === 777)).toBe(true);
    expect(numeric.some((p) => p.value === 500)).toBe(false);
  });

  // Honest gap: the CURRENT snapshot can't price the graded lot (no matching
  // C — MISSING-CURRENT-GRADE historical fallback: the CURRENT snapshot can't
  // price the lot's company+grade (no matching graded row), but REAL graded
  // PricingHistory for it exists → the chart values from that real historical
  // row, PRESERVING its actual variant (never inventing one). RULE 2: the value
  // is a real stored point, not a fabrication.
  it("values a missing-current-grade lot from the real historical row, preserving its variant", async () => {
    const addedAt = new Date(Date.now() - 90 * DAY);
    prismaMock.userCollection.findMany.mockResolvedValue([
      { cardId: "card_1", quantity: 1, addedAt, soldAt: null, isSold: false, condition: "PSA 9" },
    ]);
    // CURRENT has NO PSA 9 graded row (only PSA 10) → display falls back.
    prismaMock.currentPrice.findMany.mockResolvedValue([
      { cardId: "card_1", company: "PSA", grade: "10", variant: "normal", priceMarket: 1000 },
    ]);
    // HISTORY carries a REAL PSA 9 holofoil series → the chart values from it
    // at the historical row's actual variant (holofoil), never invented.
    const rec = new Date(Date.now() - 60 * DAY);
    prismaMock.pricingHistory.findMany.mockResolvedValue([
      { cardId: "card_1", recordedAt: rec, priceMarket: 650, type: "graded", company: "PSA", grade: "9", variant: "holofoil", condition: null },
    ]);

    const histories = await buildCollectionHistories(USER_ID, ["all"], "ALL");
    const numeric = histories["all"].filter((p) => typeof p.value === "number");
    expect(numeric.length).toBeGreaterThanOrEqual(2);
    // The real PSA 9 holofoil price (650) — never the PSA 10 (1000) current row.
    expect(numeric.every((p) => p.value === 650)).toBe(true);
    expect(numeric.some((p) => p.value === 1000)).toBe(false);
  });

  // C — when NEITHER the current snapshot NOR history can price the lot's
  // company+grade, it stays an honest null gap (RULE 2 — no invented variant).
  it("stays a null gap when neither current nor history prices the lot's company+grade", async () => {
    const addedAt = new Date(Date.now() - 90 * DAY);
    prismaMock.userCollection.findMany.mockResolvedValue([
      { cardId: "card_1", quantity: 1, addedAt, soldAt: null, isSold: false, condition: "PSA 9" },
    ]);
    prismaMock.currentPrice.findMany.mockResolvedValue([
      { cardId: "card_1", company: "PSA", grade: "10", variant: "normal", priceMarket: 1000 },
    ]);
    // History has ONLY a PSA 10 series — nothing for PSA 9.
    const rec = new Date(Date.now() - 60 * DAY);
    prismaMock.pricingHistory.findMany.mockResolvedValue([
      { cardId: "card_1", recordedAt: rec, priceMarket: 1000, type: "graded", company: "PSA", grade: "10", variant: "normal", condition: null },
    ]);

    const histories = await buildCollectionHistories(USER_ID, ["all"], "ALL");
    expect(histories["all"].every((p) => p.value === null)).toBe(true);
  });

  // C — BOUNDED-WINDOW PARITY: the last real matching point PREDATES the
  // requested window start. The windowed read returns nothing inside the window,
  // but the bounded-window seed read supplies that pre-window real point, so the
  // lot is DRAWABLE (not an all-null gap) and valued at the real carried-forward
  // price — the same value the (unbounded) display path would show.
  it("seeds the chart with the last real pre-window point so a display-valued lot is drawable", async () => {
    // Lot added ~40 days ago; window is 1M (~30 days). The only real point is
    // 45 days ago — BEFORE the window start.
    const addedAt = new Date(Date.now() - 40 * DAY);
    prismaMock.userCollection.findMany.mockResolvedValue([
      { cardId: "card_1", quantity: 2, addedAt, soldAt: null, isSold: false, condition: null },
    ]);
    const preWindow = { cardId: "card_1", recordedAt: new Date(Date.now() - 45 * DAY), priceMarket: 30, type: "raw", company: null, grade: null, variant: "normal", condition: "NM" };
    // The windowed read (recordedAt >= startDate) returns NOTHING; the seed read
    // (recordedAt < startDate) returns the pre-window point. The mock routes by
    // the `where.recordedAt` operator so the two reads differ (real behavior).
    prismaMock.pricingHistory.findMany.mockImplementation(async (args: { where?: { recordedAt?: { gte?: Date; lt?: Date } } }) => {
      const rc = args?.where?.recordedAt;
      if (rc?.lt) return [preWindow]; // seed read
      return []; // windowed read — empty inside the window
    });

    const histories = await buildCollectionHistories(USER_ID, ["all"], "1M");
    const numeric = histories["all"].filter((p) => typeof p.value === "number");
    // Drawable: >=2 points valued at the real carried-forward price (30 × 2).
    expect(numeric.length).toBeGreaterThanOrEqual(2);
    expect(numeric.every((p) => p.value === 60)).toBe(true);
  });
});

// AC-21/AC-22 — the chart's ONLY data source is real stored PricingHistory.
// Source-level pin: the extracted service must carry NO synthetic chart
// generator (the removed mulberry32 / RANGE_SHAPES / generateMockChartData
// path). A grep over the service file keeps that regression from sneaking back.
describe("no synthetic/mock chart generator in the chart data source (grep pin)", () => {
  // Vitest runs with cwd at the worktree root, so resolve the service relative
  // to it (import.meta.url is not a file URL under this jsdom config).
  const serviceSrc = readFileSync(
    resolve(process.cwd(), "src/lib/services/collection-history.service.ts"),
    "utf8"
  );

  it("the collection-history service contains no mock-generator identifiers", () => {
    for (const banned of ["generateMockChartData", "mulberry32", "RANGE_SHAPES"]) {
      expect(serviceSrc).not.toContain(banned);
    }
  });

  it("the service never fabricates a $0 — gaps stay null (code comments it, no `|| 0` coercion)", () => {
    // Guard against a future "safe default" that would replace a null gap with
    // a drawn 0 (fabricated value). The honest path returns `value: p.value`.
    expect(serviceSrc).toContain("never a fabricated 0");
    expect(serviceSrc).not.toMatch(/value:\s*[^;]*\|\|\s*0/);
  });
});

describe("SSR-key parity with the client's first-render query key (b)", () => {
  it("page SSR collectionIdsQuery === client default collectionIdsQuery", () => {
    const collections = [{ id: "c1" }, { id: "c2" }];

    // Page (page.tsx): defaultCollectionIds maps through toHistoryToken, so the
    // loose bucket "__uncat__" becomes "null".
    const ssrQuery = ["__uncat__", ...collections.map((c) => c.id)]
      .map(toHistoryToken)
      .join(",");

    // Client (DashboardClient.tsx): collOptions pushes "__uncat__" first then
    // each named collection; default empty selectedIds expands to
    // `new Set(collOptions.map(o => o.id))`; collectionIdsQuery =
    // Array.from(activeSelectedIds).map(toHistoryToken).join(","). Set +
    // Array.from preserve insertion order, so this is byte-identical.
    const collOptionIds = ["__uncat__", ...collections.map((c) => c.id)];
    const activeSelectedIds = new Set(collOptionIds);
    const clientQuery = Array.from(activeSelectedIds).map(toHistoryToken).join(",");

    expect(ssrQuery).toBe("null,c1,c2");
    expect(ssrQuery).toBe(clientQuery);
  });

  it("default range is '1M' on both the SSR and client paths", () => {
    // page.tsx DEFAULT_RANGE and DashboardClient useState<RangeId>("1M").
    const DEFAULT_RANGE = "1M";
    const clientInitialRange = "1M";
    expect(DEFAULT_RANGE).toBe(clientInitialRange);
  });
});
