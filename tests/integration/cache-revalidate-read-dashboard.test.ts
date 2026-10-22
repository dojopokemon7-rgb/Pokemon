import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Audit 12 F3 (RULE 4) — the dashboard SSR read of `dashboard:{userId}` must
 * re-parse the cached blob with a Zod schema and treat a WRONG-shape blob as a
 * cache MISS (fall through to the live Prisma reads, which rebuild + re-cache
 * the correct shape), never cast + render it verbatim. Prisma / cache / session
 * / history service / the client component are MOCKED — no live DB/network.
 */

const prismaMock = vi.hoisted(() => ({
  userCollection: { findMany: vi.fn() },
  collection: { findMany: vi.fn() },
  pricingHistory: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const cacheMock = vi.hoisted(() => ({
  cacheGetJson: vi.fn(async (): Promise<unknown> => null),
  cacheSetJson: vi.fn(async () => undefined),
}));
vi.mock("@/lib/utils/cache", () => cacheMock);

const sessionMock = vi.hoisted(() => ({
  getServerSession: vi.fn(async () => ({ user: { id: "u1", name: "Ash Ketchum" } })),
}));
vi.mock("@/lib/utils/get-server-session", () => sessionMock);

vi.mock("@/lib/services/collection-history.service", () => ({
  buildCollectionHistories: vi.fn(async () => ({})),
}));

// Render-free: the server component returns <DashboardClient .../>, we assert on
// its props. Stub the client component so no client-only import is pulled in.
vi.mock("@/app/(dashboard)/dashboard/_components/DashboardClient", () => ({
  default: () => null,
}));

import DashboardPage from "@/app/(dashboard)/dashboard/page";

// A fresh UserCollection row shaped like the dashboard's Prisma select.
const freshRow = {
  id: "uc1",
  cardId: "c1",
  quantity: 1,
  isFoil: false,
  purchasePrice: null,
  condition: null,
  collectionId: null,
  isSold: false,
  soldPrice: null,
  soldAt: null,
  card: {
    id: "c1",
    externalId: "base1-4",
    name: "Charizard",
    imageUrl: "u",
    marketPrice: 10,
    weeklyChangePct: null,
    set: { name: "Base" },
    currentPrices: [],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  cacheMock.cacheGetJson.mockResolvedValue(null);
  prismaMock.userCollection.findMany.mockResolvedValue([freshRow]);
  prismaMock.collection.findMany.mockResolvedValue([]);
  prismaMock.pricingHistory.findMany.mockResolvedValue([]);
});

describe("DashboardPage — re-validate cached read (audit 12 F3)", () => {
  it("treats a WRONG-shape cached blob as a miss and rebuilds from Prisma", async () => {
    // Old/wrong shape: `rows` is not an array of row objects with an id.
    cacheMock.cacheGetJson.mockResolvedValue({ rows: "nope", collections: [] });

    const el = await DashboardPage();

    // Fell through to the live reads (the stale blob was NOT used).
    expect(prismaMock.userCollection.findMany).toHaveBeenCalled();
    expect(el.props.initialItems).toHaveLength(1);
    expect(el.props.initialItems[0].id).toBe("uc1");
    // Rebuilt → re-cached the correct shape.
    expect(cacheMock.cacheSetJson).toHaveBeenCalled();
  });

  it("uses a VALID cached blob without hitting Prisma", async () => {
    cacheMock.cacheGetJson.mockResolvedValue({
      rows: [{ id: "cached-uc", cardId: "c9", quantity: 1 }],
      collections: [],
      histories: { "__all__": [{ date: "2026-01-01", value: 5 }] },
    });

    const el = await DashboardPage();

    expect(prismaMock.userCollection.findMany).not.toHaveBeenCalled();
    expect(el.props.initialItems).toHaveLength(1);
    expect(el.props.initialItems[0].id).toBe("cached-uc");
  });
});
