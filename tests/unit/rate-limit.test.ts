import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Rate-limit utility tests (src/lib/utils/rate-limit.ts).
 *
 * Proves the four load-bearing contracts:
 *   - under-limit → null (allowed);
 *   - over-limit  → 429 with a Retry-After header + { error, message } body;
 *   - FIRST hit (count === 1) sets the window TTL exactly once (expire NX);
 *   - FAIL-OPEN (AGENTS.md RULE 1): a rejecting Redis op → null (allowed), no throw;
 *   - clientIp proxy-header parsing (x-forwarded-for first hop → x-real-ip → "unknown");
 *   - identity keying: user → "u:<id>", ip → "ip:<ip>".
 *
 * ioredis is mocked. `enforceRateLimit` uses redis.multi().incr().expire().exec()
 * then redis.ttl(), so the mock exposes a chainable multi() recorder + ttl().
 */

// Chainable multi() recorder: captures the INCR key + the EXPIRE args, and the
// exec() reply is `incrReply` (set per-test). Hoisted so vi.mock can see it.
const redisMock = vi.hoisted(() => {
  const state = {
    incrKey: "" as string,
    expireArgs: [] as unknown[],
    incrReply: 1 as number | Error,
    ttlReply: 60 as number,
    execCalls: 0,
  };
  const multi = () => {
    const chain = {
      incr(key: string) {
        state.incrKey = key;
        return chain;
      },
      expire(...args: unknown[]) {
        state.expireArgs = args;
        return chain;
      },
      async exec() {
        state.execCalls++;
        if (state.incrReply instanceof Error) throw state.incrReply;
        // ioredis exec() shape: [[err, value], ...]
        return [[null, state.incrReply]];
      },
    };
    return chain;
  };
  return {
    __state: state,
    multi: vi.fn(multi),
    ttl: vi.fn(async () => state.ttlReply),
  };
});
vi.mock("@/lib/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/redis")>();
  return { ...actual, redis: redisMock };
});

import { enforceRateLimit, clientIp, creditTier } from "@/lib/utils/rate-limit";

const TIER = { bucket: "test", limit: 3, windowSeconds: 60 };

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/x", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.__state.incrKey = "";
  redisMock.__state.expireArgs = [];
  redisMock.__state.incrReply = 1;
  redisMock.__state.ttlReply = 60;
  redisMock.__state.execCalls = 0;
});

describe("enforceRateLimit — allow / block", () => {
  it("returns null (allowed) when count is at or under the limit", async () => {
    redisMock.__state.incrReply = 3; // == limit
    const res = await enforceRateLimit(req(), TIER, { kind: "ip", id: "1.2.3.4" });
    expect(res).toBeNull();
  });

  it("returns 429 with Retry-After + { error, message } once over the limit", async () => {
    redisMock.__state.incrReply = 4; // > limit (3)
    redisMock.__state.ttlReply = 42;
    const res = await enforceRateLimit(req(), TIER, { kind: "ip", id: "1.2.3.4" });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
    expect(res!.headers.get("Retry-After")).toBe("42");
    const body = await res!.json();
    expect(body.error).toBe("Too Many Requests");
    expect(typeof body.message).toBe("string");
  });

  it("falls back to the window length for Retry-After when TTL is unavailable", async () => {
    redisMock.__state.incrReply = 4;
    redisMock.__state.ttlReply = -1; // no TTL
    const res = await enforceRateLimit(req(), TIER, { kind: "ip", id: "1.2.3.4" });
    expect(res!.headers.get("Retry-After")).toBe("60");
  });
});

describe("enforceRateLimit — TTL on first hit", () => {
  it("sets the window expiry with NX (the pipeline always carries the expire)", async () => {
    redisMock.__state.incrReply = 1; // first hit
    await enforceRateLimit(req(), TIER, { kind: "ip", id: "9.9.9.9" });
    expect(redisMock.__state.expireArgs).toEqual([redisMock.__state.incrKey, 60, "NX"]);
  });
});

describe("enforceRateLimit — FAIL-OPEN (RULE 1)", () => {
  it("returns null (allowed) and does not throw when the Redis pipeline rejects", async () => {
    redisMock.__state.incrReply = new Error("ECONNREFUSED");
    const res = await enforceRateLimit(req(), TIER, { kind: "user", id: "u1" });
    expect(res).toBeNull();
  });

  it("returns null on a non-numeric INCR reply (unexpected shape → fail open)", async () => {
    // @ts-expect-error — deliberately malformed reply for the fail-open path.
    redisMock.__state.incrReply = "oops";
    const res = await enforceRateLimit(req(), TIER, { kind: "ip", id: "1.2.3.4" });
    expect(res).toBeNull();
  });
});

describe("enforceRateLimit — identity keying", () => {
  it("keys an authenticated user as u:<id>", async () => {
    redisMock.__state.incrReply = 1;
    await enforceRateLimit(req(), TIER, { kind: "user", id: "user_abc" });
    expect(redisMock.__state.incrKey).toContain("u:user_abc");
    expect(redisMock.__state.incrKey).toContain("test"); // bucket
  });

  it("keys an unauthenticated caller as ip:<ip>", async () => {
    redisMock.__state.incrReply = 1;
    await enforceRateLimit(req(), TIER, { kind: "ip", id: "5.6.7.8" });
    expect(redisMock.__state.incrKey).toContain("ip:5.6.7.8");
  });
});

describe("clientIp — proxy header resolution", () => {
  it("takes the first hop of x-forwarded-for", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    expect(clientIp(req({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
  });

  it("falls back to 'unknown' when no proxy header is present", () => {
    expect(clientIp(req())).toBe("unknown");
  });
});

describe("tier builders — env override with baked-in defaults", () => {
  it("uses the baked-in default when the env var is unset", () => {
    delete process.env.RATELIMIT_CREDIT_PER_MIN;
    expect(creditTier()).toEqual({ bucket: "credit", limit: 10, windowSeconds: 60 });
  });

  it("honors a positive-integer env override", () => {
    process.env.RATELIMIT_CREDIT_PER_MIN = "25";
    expect(creditTier().limit).toBe(25);
    delete process.env.RATELIMIT_CREDIT_PER_MIN;
  });

  it("ignores an invalid env value (falls back to the default)", () => {
    process.env.RATELIMIT_CREDIT_PER_MIN = "-5";
    expect(creditTier().limit).toBe(10);
    delete process.env.RATELIMIT_CREDIT_PER_MIN;
  });
});
