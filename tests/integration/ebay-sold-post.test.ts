import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Button-gated eBay-sold pull — POST /api/cards/[id]/ebay-sold.
 *
 * Pins the short-circuit: with SCRYDEX_ONVIEW_ENABLED UNSET (allowance off)
 * AND the big-bulk credit gate DENY, the POST returns {pulled:false} and does
 * NOT call pullAndStoreSoldListings (no Scrydex HTTP, honest no-op — never an
 * error). Mocked Prisma + Scrydex service + Redis cache — ZERO network/credits.
 */

const prismaMock = vi.hoisted(() => ({
  card: { findFirst: vi.fn() },
  soldListing: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const pricingMock = vi.hoisted(() => ({ pullAndStoreSoldListings: vi.fn() }));
vi.mock("@/lib/services/scrydex-pricing.service", () => pricingMock);

const cacheMock = vi.hoisted(() => ({ cacheGetJson: vi.fn(), cacheSetJson: vi.fn() }));
vi.mock("@/lib/utils/cache", () => cacheMock);

vi.mock("@/lib/redis", () => ({
  RedisKeys: { soldRows: (id: string) => `s:${id}` },
  CACHE_TTL: { soldRows: 120 },
}));

import { POST } from "@/app/api/cards/[id]/ebay-sold/route";

function soldRequest(externalId: string): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`http://localhost/api/cards/${externalId}/ebay-sold`, { method: "POST" }),
    { params: Promise.resolve({ id: externalId }) },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.SCRYDEX_ONVIEW_ENABLED;
  delete process.env.SCRYDEX_LIVE_CREDITS_APPROVED;
});

describe("POST /api/cards/[id]/ebay-sold", () => {
  it("allowance OFF + gate DENY → {pulled:false}, NO pullAndStoreSoldListings call", async () => {
    const [req, ctx] = soldRequest("base1-4");
    const res = await POST(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.pulled).toBe(false);
    expect(pricingMock.pullAndStoreSoldListings).not.toHaveBeenCalled();
  });
});
