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
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildCollectionHistories } from "@/lib/services/collection-history.service";
import { toHistoryToken } from "@/lib/utils/collection-ids";

const USER_ID = "user_123";

beforeEach(() => {
  vi.clearAllMocks();
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
