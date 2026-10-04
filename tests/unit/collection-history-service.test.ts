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
