import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * FEAT-002 B (integration) — the dashboard reflects the chosen collection
 * after an add. Prisma is MOCKED (no live DB/network). Combines the
 * ownership-coercion contract (collection-add-ownership.test.ts) with the
 * drawable-series contract (collection-history-service.test.ts):
 *
 *   1. An add carrying a NON-"Main" OWNED collectionId files the lot under
 *      that collection id (AC-17).
 *   2. A FOREIGN (non-owned) collectionId coerces to null (RULE 5 / AC-15) —
 *      filed loose, no 4xx, no id-enumeration leak.
 *   3. buildCollectionHistories for that owned cuid then returns a DRAWABLE
 *      (>= 2 non-null point) series — the chart the chosen collection now
 *      refetches (HIGH-1) actually has something to draw (A1 anchor).
 */

const prismaMock = vi.hoisted(() => ({
  collection: { findMany: vi.fn(), create: vi.fn() },
  userCollection: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  cardSet: { upsert: vi.fn() },
  card: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  pricingHistory: { createMany: vi.fn(), findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const USER_ID = "user_123";
vi.mock("@/lib/utils/auth-guard", () => ({
  requireAuth: vi.fn(async () => ({ unauthorized: null, session: { user: { id: USER_ID } } })),
}));

vi.mock("@/lib/utils/cache", () => ({
  cacheGetJson: vi.fn(async () => null),
  cacheSetJson: vi.fn(async () => undefined),
  invalidateUserCaches: vi.fn(async () => undefined),
}));

import { GET as collectionGET, POST as collectionAddPOST } from "@/app/api/users/me/collection/route";
import { buildCollectionHistories } from "@/lib/services/collection-history.service";

const CARD = { id: "card_1", externalId: "base1-4", marketPrice: 10 };
const OWNED = "col_owned";

function addBody(cards: unknown[]) {
  return new Request("http://localhost/api/users/me/collection", {
    method: "POST",
    body: JSON.stringify({ cards }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.cardSet.upsert.mockResolvedValue({ id: "set_1" });
  prismaMock.card.findFirst.mockResolvedValue(CARD);
  prismaMock.card.update.mockResolvedValue(CARD);
  prismaMock.pricingHistory.createMany.mockResolvedValue({});
});

describe("FEAT-002 B — add under chosen collection then dashboard draws it", () => {
  it("files the lot under a non-'Main' OWNED collectionId (AC-17)", async () => {
    prismaMock.collection.findMany.mockResolvedValue([{ id: OWNED, name: 'Vintage' }, { id: 'col_main', name: 'Main' }]);
    prismaMock.userCollection.findMany.mockResolvedValueOnce([]);
    prismaMock.userCollection.create.mockResolvedValueOnce({ id: "uc_1" });

    const res = await collectionAddPOST(
      addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1, collectionId: OWNED }])
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.added).toBe(1);
    expect(prismaMock.userCollection.create.mock.calls[0][0].data.collectionId).toBe(OWNED);
    // The scoped find also looked under that owned bucket, not loose.
    expect(prismaMock.userCollection.findMany.mock.calls[0][0].where.collectionId).toBe(OWNED);
  });

  it("coerces a FOREIGN collectionId to the user's MAIN (RULE 5 / AC-15)", async () => {
    prismaMock.collection.findMany.mockResolvedValue([{ id: OWNED, name: 'Vintage' }, { id: 'col_main', name: 'Main' }]);
    prismaMock.userCollection.findMany.mockResolvedValueOnce([]);
    prismaMock.userCollection.create.mockResolvedValueOnce({ id: "uc_2" });

    const res = await collectionAddPOST(
      addBody([{ externalId: "base1-4", name: "Alakazam", quantity: 1, collectionId: "col_foreign" }])
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.added).toBe(1);
    expect(prismaMock.userCollection.create.mock.calls[0][0].data.collectionId).toBe('col_main');
    expect(prismaMock.userCollection.findMany.mock.calls[0][0].where.collectionId).toBe('col_main');
  });

  it("buildCollectionHistories for the owned bucket returns a drawable (>=2-point) series after the add", async () => {
    // The add filed one lot under OWNED (addedAt ~now). The dashboard chart,
    // which HIGH-1 now invalidates on add, queries this bucket: the A1 anchor
    // plus the now-point must give >= 2 real points so the chart draws.
    const addedAt = new Date(Date.now() - 60 * 1000); // ~1 min ago
    prismaMock.userCollection.findMany.mockResolvedValueOnce([
      { cardId: "card_1", quantity: 2, addedAt, soldAt: null, isSold: false },
    ]);
    prismaMock.pricingHistory.findMany.mockResolvedValueOnce([
      { cardId: "card_1", recordedAt: new Date(addedAt.getTime() - 30 * 1000), priceMarket: 10 },
    ]);

    const histories = await buildCollectionHistories(USER_ID, [OWNED], "1M");

    // The service was asked for the owned cuid and keyed the series by it.
    expect(prismaMock.userCollection.findMany.mock.calls[0][0].where.collectionId).toBe(OWNED);
    const series = histories[OWNED];
    const numeric = series.filter((p) => typeof p.value === "number");
    expect(numeric.length).toBeGreaterThanOrEqual(2); // drawable
    expect(numeric.every((p) => p.value === 20)).toBe(true); // 10 × qty 2, never fabricated
  });
});

describe("FEAT-003 — collection read exposes stored 7-day change", () => {
  it("selects weeklyChangeAbs and weeklyChangePct on the card", async () => {
    prismaMock.userCollection.findMany.mockResolvedValueOnce([]);
    const res = await collectionGET(new Request("http://localhost/api/users/me/collection"));
    expect(res.status).toBe(200);
    const sel = prismaMock.userCollection.findMany.mock.calls[0][0].select.card.select;
    expect(sel.weeklyChangeAbs).toBe(true);
    expect(sel.weeklyChangePct).toBe(true);
  });
});
