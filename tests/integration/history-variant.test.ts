import { describe, it, expect, vi, beforeEach } from "vitest";

/** FEAT-002 — /api/cards/[id]/history is variant- and condition-aware. Mocked Prisma + Redis; no live DB. */
const prismaMock = vi.hoisted(() => ({
  card: { findUnique: vi.fn() },
  pricingHistory: { findMany: vi.fn() },
  currentPrice: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const redisMock = vi.hoisted(() => ({
  get: vi.fn(async (): Promise<string | null> => null),
  set: vi.fn(async () => "OK"),
  del: vi.fn(async () => 0),
  keys: vi.fn(async () => []),
}));
vi.mock("@/lib/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/redis")>();
  return { ...actual, redis: redisMock };
});

import { GET } from "@/app/api/cards/[id]/history/route";

const ctx = { params: Promise.resolve({ id: "neo3-65" }) };
const call = (qs = "") => GET(new Request(`http://localhost/x${qs}`), ctx);
const h = (variant: string, condition: string, date: string, price: number, extra: object = {}) => ({
  variant, condition, type: "raw", company: null, grade: null,
  priceMarket: price, recordedAt: new Date(`${date}T10:00:00Z`), ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockResolvedValue(null);
  prismaMock.card.findUnique.mockResolvedValue({ id: "card_1" });
  prismaMock.currentPrice.findMany.mockResolvedValue([]);
});

describe("GET /api/cards/[id]/history (variant-aware)", () => {
  const rows = [
    h("normal", "NM", "2026-01-01", 1),
    h("holofoil", "NM", "2026-01-01", 100),
    h("holofoil", "LP", "2026-01-01", 80),
    h("holofoil", "NM", "2026-01-02", 110),
    h("holofoil", "NM", "2026-01-02", 120), // same ISO date: last wins
    h("holofoil", "NM", "2026-01-03", 130, { type: "graded", company: "PSA", grade: "10" }),
  ];

  it("filters by ?variant= and returns variants[]", async () => {
    prismaMock.pricingHistory.findMany.mockResolvedValue(rows);
    const body = await (await call("?variant=normal")).json();
    expect(body.raw).toEqual([{ date: "2026-01-01", price: 1 }]);
    expect(body.graded).toEqual({});
    expect(body.variants).toEqual(["normal", "holofoil"]);
  });

  it("uses best-ranked raw condition only and collapses same-date points (last wins)", async () => {
    prismaMock.pricingHistory.findMany.mockResolvedValue(rows);
    const body = await (await call("?variant=holofoil")).json();
    expect(body.raw).toEqual([
      { date: "2026-01-01", price: 100 }, // NM, not LP 80
      { date: "2026-01-02", price: 120 },
    ]);
    expect(body.graded["PSA|10"]).toEqual([{ date: "2026-01-03", price: 130 }]);
  });

  it("defaults to the CurrentPrice default variant when ?variant omitted", async () => {
    prismaMock.currentPrice.findMany.mockResolvedValue([
      { variant: "holofoil", type: "raw", condition: "NM", priceMarket: 100 },
      { variant: "normal", type: "raw", condition: "LP", priceMarket: 1 },
    ]);
    prismaMock.pricingHistory.findMany.mockResolvedValue(rows);
    const body = await (await call()).json();
    expect(body.raw.map((p: { price: number }) => p.price)).toEqual([100, 120]);
  });

  it("falls through to Prisma when a cached blob lacks variants (stale shape)", async () => {
    redisMock.get.mockResolvedValue(JSON.stringify({ raw: [{ date: "2026-01-01", price: 9 }], graded: {} }));
    prismaMock.pricingHistory.findMany.mockResolvedValue(rows);
    const body = await (await call()).json();
    expect(prismaMock.pricingHistory.findMany).toHaveBeenCalled();
    expect(body.variants).toBeDefined();
  });

  it("does not cache an empty result", async () => {
    prismaMock.pricingHistory.findMany.mockResolvedValue([]);
    const body = await (await call("?variant=normal")).json();
    expect(body).toEqual({ raw: [], graded: {}, variants: [] });
    expect(redisMock.set).not.toHaveBeenCalled();
  });
});
