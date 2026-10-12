import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Security-hardening WIRING integration (F-2 + F-3). Everything external is
 * MOCKED (Prisma / Redis / auth / eBay service) — no live DB or network.
 *
 *   F-2 — GET /api/ebay/search is rate-limited per IP (searchTier):
 *     (a) over the limit → 429 + Retry-After, and searchEbayListings is NOT
 *         called (the limiter ran FIRST, before cache lookup / live call).
 *     (b) under the limit → NOT 429 (200, limiter allowed through).
 *     (c) Redis-down (pipeline rejects) → NOT 429 (fail-open, RULE 1).
 *
 *   F-3 — PATCH /api/cards/recognize scopes the ScanFeedback write to the
 *   caller via updateMany({ where: { id, userId } }):
 *     (a) a cross-user feedbackId → updateMany called with the session userId
 *         (0-row no-op), still { success: true }; the old unscoped update() is
 *         NEVER called.
 *     (b) an anonymous caller → updateMany called with userId: null (option (a)
 *         best-effort), still { success: true }.
 */

// --- Shared mocks ---------------------------------------------------------

const prismaMock = vi.hoisted(() => ({
  card: { findMany: vi.fn(), findUnique: vi.fn() },
  scanFeedback: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const authMock = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: authMock.getSession } } }));

// Redis mock: a chainable multi() recorder whose exec() reply is driven by a
// hoisted state, plus the ttl()/get()/set() ops the ebay route touches. The
// REAL RedisKeys registry is preserved so key building is production-accurate.
const redisState = vi.hoisted(() => ({ incrReply: 1 as number | Error }));
const redisMock = vi.hoisted(() => {
  const state = redisState;
  const multi = vi.fn(() => {
    const chain = {
      incr: vi.fn(() => chain),
      expire: vi.fn(() => chain),
      exec: vi.fn(async () => {
        if (state.incrReply instanceof Error) throw state.incrReply;
        return [[null, state.incrReply]];
      }),
    };
    return chain;
  });
  return {
    multi,
    ttl: vi.fn(async () => 60),
    get: vi.fn(async () => null),
    set: vi.fn(async () => "OK"),
  };
});
vi.mock("@/lib/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/redis")>();
  return { ...actual, redis: redisMock };
});

const ebayMock = vi.hoisted(() => ({ searchEbayListings: vi.fn() }));
vi.mock("@/lib/services/ebay.service", () => ({ searchEbayListings: ebayMock.searchEbayListings }));

import { GET as ebaySearchGet } from "@/app/api/ebay/search/route";
import { PATCH as recognizePatch } from "@/app/api/cards/recognize/route";
import { NextRequest } from "next/server";

function ebayReq(): NextRequest {
  // The route reads `request.nextUrl.searchParams`, so build a real NextRequest.
  return new NextRequest(
    "http://localhost/api/ebay/search?name=Charizard&game=pokemon"
  );
}

function patchReq(body: unknown): Request {
  return new Request("http://localhost/api/cards/recognize", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.RATELIMIT_SEARCH_PER_MIN; // default 60/min
  redisState.incrReply = 1;
  ebayMock.searchEbayListings.mockResolvedValue([]);
});

afterEach(() => {
  delete process.env.RATELIMIT_SEARCH_PER_MIN;
});

// --------------------------------------------------------------------------
// F-2
// --------------------------------------------------------------------------
describe("F-2 — GET /api/ebay/search per-IP rate limit", () => {
  it("over the limit → 429 + Retry-After, and does NOT call the eBay service", async () => {
    redisState.incrReply = 61; // > default 60
    const res = await ebaySearchGet(ebayReq());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    const body = await res.json();
    expect(body.error).toBe("Too Many Requests");
    // Limiter ran FIRST — before cache lookup / live eBay call.
    expect(ebayMock.searchEbayListings).not.toHaveBeenCalled();
  });

  it("under the limit → NOT 429 (200, limiter allowed through)", async () => {
    redisState.incrReply = 1; // first hit, well under limit
    const res = await ebaySearchGet(ebayReq());
    expect(res.status).toBe(200);
    expect(ebayMock.searchEbayListings).toHaveBeenCalled();
  });

  it("Redis-down (pipeline rejects) → fail-open, NOT 429 (RULE 1)", async () => {
    redisState.incrReply = new Error("ECONNREFUSED");
    const res = await ebaySearchGet(ebayReq());
    expect(res.status).toBe(200); // a cache outage never turns into a 429
    expect(ebayMock.searchEbayListings).toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// F-3
// --------------------------------------------------------------------------
describe("F-3 — PATCH /api/cards/recognize user-scoped feedback write", () => {
  it("cross-user feedbackId → updateMany scoped to the session user (0-row no-op), success:true, old update() never called", async () => {
    authMock.getSession.mockResolvedValue({ user: { id: "user_1" } });
    prismaMock.scanFeedback.updateMany.mockResolvedValue({ count: 0 });

    const res = await recognizePatch(
      patchReq({ feedbackId: "fb_not_mine", pickedCardId: "base1-4" })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(prismaMock.scanFeedback.updateMany).toHaveBeenCalledWith({
      where: { id: "fb_not_mine", userId: "user_1" },
      data: { pickedCardId: "base1-4" },
    });
    expect(prismaMock.scanFeedback.update).not.toHaveBeenCalled();
  });

  it("anonymous caller → updateMany scoped to userId:null (best-effort), still success:true", async () => {
    authMock.getSession.mockResolvedValue(null);
    prismaMock.scanFeedback.updateMany.mockResolvedValue({ count: 0 });

    const res = await recognizePatch(
      patchReq({ feedbackId: "fb_anon", pickedCardId: "base1-4" })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(prismaMock.scanFeedback.updateMany).toHaveBeenCalledWith({
      where: { id: "fb_anon", userId: null },
      data: { pickedCardId: "base1-4" },
    });
    expect(prismaMock.scanFeedback.update).not.toHaveBeenCalled();
  });
});
