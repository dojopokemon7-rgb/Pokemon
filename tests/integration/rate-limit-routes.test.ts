import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Rate-limit WIRING integration (mocked Prisma / Redis / auth-guard — no live
 * DB or network). Proves the limiter is wired correctly on a real route and
 * that a cheap exempt route is NOT limited:
 *
 *   (a) POST /api/cards/reprice over the credit limit → 429 + Retry-After, and
 *       the route does NOT fetch upstream or write the shared Card.marketPrice
 *       (the limiter runs BEFORE the expensive work).
 *   (b) under the limit → the route behaves exactly as today (prices returned).
 *   (c) Redis-down (the pipeline rejects) → request is ALLOWED (fail-open), the
 *       route proceeds (AGENTS.md RULE 1).
 *   (d) EXEMPT: GET /api/health is NOT rate-limited — it never touches the
 *       limiter's redis.multi (and returns its normal 200/503).
 */

const USER_ID = "user_rl";

const guardMock = vi.hoisted(() => ({
  requireAuth: vi.fn(async () => ({
    unauthorized: null,
    session: { user: { id: USER_ID } },
  })),
}));
vi.mock("@/lib/utils/auth-guard", () => guardMock);

const prismaMock = vi.hoisted(() => ({
  card: { update: vi.fn() },
  // health route reads $queryRaw.
  $queryRaw: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

// Redis mock: a chainable multi() recorder whose exec() reply is controllable,
// plus the ttl()/get()/set()/ping() ops the routes touch. The REAL RedisKeys
// registry is preserved (importOriginal) so key building is production-accurate.
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
    ping: vi.fn(async () => "PONG"),
  };
});
vi.mock("@/lib/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/redis")>();
  return { ...actual, redis: redisMock, pingRedis: async () => true };
});

import { POST as repricePost } from "@/app/api/cards/reprice/route";
import { GET as healthGet } from "@/app/api/health/route";

const fetchSpy = vi.spyOn(globalThis, "fetch");

function repriceReq(): Request {
  return new Request("http://localhost/api/cards/reprice", {
    method: "POST",
    body: JSON.stringify({ externalIds: ["base1-4"] }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.RATELIMIT_CREDIT_PER_MIN; // default 10/min
  redisState.incrReply = 1;
  redisMock.multi.mockClear();
});

afterEach(() => {
  delete process.env.RATELIMIT_CREDIT_PER_MIN;
});

describe("POST /api/cards/reprice — rate limited by user", () => {
  it("returns 429 + Retry-After once over the limit and does NOT fetch or write", async () => {
    redisState.incrReply = 11; // > default 10
    const res = await repricePost(repriceReq());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    const body = await res.json();
    expect(body.error).toBe("Too Many Requests");
    // The limiter ran BEFORE body parse / upstream fetch / shared write.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(prismaMock.card.update).not.toHaveBeenCalled();
  });

  it("under the limit, the route proceeds as today (prices returned)", async () => {
    redisState.incrReply = 1; // first hit, well under limit
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: { tcgplayer: { prices: { normal: { market: 9.5 } } } } }), {
        status: 200,
      })
    );
    const res = await repricePost(repriceReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("prices");
    // The expensive path WAS reached (limiter allowed it).
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("Redis-down (pipeline rejects) → fail-open ALLOWED, route proceeds", async () => {
    redisState.incrReply = new Error("ECONNREFUSED");
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: { tcgplayer: { prices: { normal: { market: 1 } } } } }), {
        status: 200,
      })
    );
    const res = await repricePost(repriceReq());
    expect(res.status).toBe(200); // NOT 429 — a cache outage never blocks
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe("GET /api/health — exempt (never rate limited)", () => {
  it("does not invoke the limiter and returns its normal status", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const res = await healthGet();
    expect(res.status).toBe(200);
    // The limiter's atomic counter (redis.multi) was never touched by health.
    expect(redisMock.multi).not.toHaveBeenCalled();
  });
});
