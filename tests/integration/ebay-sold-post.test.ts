import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Button-gated eBay-sold pull — POST /api/cards/[id]/ebay-sold.
 *
 * Pins the short-circuit: with SCRYDEX_ONVIEW_ENABLED UNSET (allowance off)
 * AND the big-bulk credit gate DENY, the POST returns {pulled:false} and does
 * NOT call pullAndStoreSoldListings (no Scrydex HTTP, honest no-op — never an
 * error). Mocked Prisma + Scrydex service + Redis cache — ZERO network/credits.
 */

import { NextResponse } from "next/server";

// SECURITY: the POST now requires a session (button-gated live credit spend).
// Mock the guard: default authed; the 401 case overrides it. The GET stays
// PUBLIC (pure Postgres read) — it never calls requireAuth.
const guardMock = vi.hoisted(() => ({
  requireAuth: vi.fn<() => Promise<{ unauthorized: unknown; session: unknown }>>(async () => ({
    unauthorized: null,
    session: { user: { id: "user_1" } },
  })),
}));
vi.mock("@/lib/utils/auth-guard", () => guardMock);

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

import { GET, POST } from "@/app/api/cards/[id]/ebay-sold/route";

function soldRequest(externalId: string): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`http://localhost/api/cards/${externalId}/ebay-sold`, { method: "POST" }),
    { params: Promise.resolve({ id: externalId }) },
  ];
}

function soldGetRequest(externalId: string): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`http://localhost/api/cards/${externalId}/ebay-sold`),
    { params: Promise.resolve({ id: externalId }) },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default authed so the existing allowance short-circuit case runs.
  guardMock.requireAuth.mockResolvedValue({
    unauthorized: null,
    session: { user: { id: "user_1" } },
  });
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

  it("SECURITY: unauthenticated POST → 401, NO pullAndStoreSoldListings call", async () => {
    // The POST can trigger a ~5cr sold-listings pull; an anonymous caller must
    // be rejected before any allowance check or writer call.
    guardMock.requireAuth.mockResolvedValue({
      unauthorized: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      session: null,
    });

    const [req, ctx] = soldRequest("base1-4");
    const res = await POST(req, ctx);

    expect(res.status).toBe(401);
    expect(pricingMock.pullAndStoreSoldListings).not.toHaveBeenCalled();
  });
});

describe("GET /api/cards/[id]/ebay-sold stays public (pure read, no auth)", () => {
  it("unauthenticated GET → 200 { listings: [] } for an unknown card (no requireAuth)", async () => {
    prismaMock.card.findFirst.mockResolvedValue(null);

    const [req, ctx] = soldGetRequest("does-not-exist");
    const res = await GET(req, ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.listings).toEqual([]);
    // The public read must NOT be gated behind the session guard.
    expect(guardMock.requireAuth).not.toHaveBeenCalled();
  });
});
