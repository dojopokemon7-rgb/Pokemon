import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * FIX E (sec-audit) — POST /api/cards/reprice now requires auth.
 *
 * The route fans out up to MAX_IDS live pokemontcg.io fetches and writes the
 * SHARED Card.marketPrice; it is only ever fired client-side by a logged-in
 * user. An unauthenticated POST must be rejected 401 BEFORE any fetch / write.
 */

const UNAUTH = {
  unauthorized: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
  session: null,
};
const guardMock = vi.hoisted(() => ({ requireAuth: vi.fn(async () => UNAUTH) }));
vi.mock("@/lib/utils/auth-guard", () => guardMock);

// Prisma + Redis are mocked so we can prove they are NEVER touched on a 401.
const prismaMock = vi.hoisted(() => ({ card: { update: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const redisMock = vi.hoisted(() => ({
  redis: { get: vi.fn(), set: vi.fn() },
  RedisKeys: { cardPrice: (id: string) => `card:price:${id}` },
}));
vi.mock("@/lib/redis", () => redisMock);

import { POST } from "@/app/api/cards/reprice/route";

const fetchSpy = vi.spyOn(globalThis, "fetch");

beforeEach(() => {
  vi.clearAllMocks();
  guardMock.requireAuth.mockResolvedValue(UNAUTH);
});

describe("POST /api/cards/reprice — auth required (FIX E)", () => {
  it("returns 401 for an unauthenticated request and never fetches or writes", async () => {
    const req = new Request("http://localhost/api/cards/reprice", {
      method: "POST",
      body: JSON.stringify({ externalIds: ["base1-4"] }),
    });

    const res = await POST(req);

    expect(res.status).toBe(401);
    // Guard short-circuits before body parse, upstream fetch, or shared write.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(prismaMock.card.update).not.toHaveBeenCalled();
  });
});
