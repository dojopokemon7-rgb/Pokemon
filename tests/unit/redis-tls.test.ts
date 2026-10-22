import { describe, it, expect } from "vitest";
import { shouldUseTls, redactRedisUrl, redisRetryDelay } from "@/lib/utils/redis-tls";

/**
 * Guards the TLS decision for the Redis connection URL. Vercel's Upstash
 * REDIS_URL is `rediss://...upstash.io` (TLS required); local/Docker is plain
 * `redis://`. ioredis does not reliably enable TLS from the scheme alone on
 * serverless, so this predicate drives an explicit `tls: {}`.
 */
describe("shouldUseTls", () => {
  it("enables TLS for a rediss:// Upstash URL", () => {
    expect(shouldUseTls("rediss://default:pw@abc.upstash.io:6379")).toBe(true);
  });

  it("enables TLS for an Upstash host even on the non-TLS redis:// scheme", () => {
    expect(shouldUseTls("redis://default:pw@abc.upstash.io:6379")).toBe(true);
  });

  it("enables TLS for the rediss:// scheme alone", () => {
    expect(shouldUseTls("rediss://example.com:6379")).toBe(true);
  });

  it("does NOT enable TLS for local redis://", () => {
    expect(shouldUseTls("redis://localhost:6379")).toBe(false);
    expect(shouldUseTls("redis://localhost:6380")).toBe(false);
  });

  it("does NOT enable TLS for the Docker service name", () => {
    expect(shouldUseTls("redis://redis:6379")).toBe(false);
  });
});

/**
 * Guards the credential redaction used in the Redis connect log (audit 12 F4).
 * The password must NEVER appear in the redacted form, on any input.
 */
describe("redactRedisUrl", () => {
  it("strips the password from an Upstash rediss:// URL", () => {
    const out = redactRedisUrl("rediss://default:s3cr3t-pw@abc.upstash.io:6379");
    expect(out).toBe("rediss://abc.upstash.io:6379");
    expect(out).not.toContain("s3cr3t-pw");
  });

  it("strips the password from a Docker requirepass redis:// URL", () => {
    const out = redactRedisUrl("redis://default:d409947a@redis:6379");
    expect(out).not.toContain("d409947a");
    expect(out).toContain("redis:6379");
  });

  it("leaves a credential-less local URL readable", () => {
    expect(redactRedisUrl("redis://localhost:6379")).toBe("redis://localhost:6379");
  });

  it("returns a constant placeholder (never the raw input) for an unparseable string", () => {
    expect(redactRedisUrl("not a url:with:colons")).toBe("<redis-url>");
  });
});

/**
 * Guards the reconnect backoff (audit 12 F5). Returning null would end the
 * ioredis client permanently and leave the singleton holding a dead client →
 * caching + rate limiting silently off until a restart. The strategy must
 * ALWAYS return a capped numeric delay so the client self-heals when Redis
 * returns.
 */
describe("redisRetryDelay", () => {
  it("NEVER returns null — always a number — for any attempt count", () => {
    for (const times of [0, 1, 5, 10, 11, 50, 1000]) {
      const delay = redisRetryDelay(times);
      expect(delay).not.toBeNull();
      expect(typeof delay).toBe("number");
    }
  });

  it("ramps below the cap for small attempt counts", () => {
    expect(redisRetryDelay(1)).toBe(200);
    expect(redisRetryDelay(2)).toBe(400);
    expect(redisRetryDelay(3)).toBe(800);
  });

  it("caps the delay at 3000ms so it keeps retrying indefinitely", () => {
    expect(redisRetryDelay(11)).toBe(3000);
    expect(redisRetryDelay(50)).toBe(3000);
    expect(redisRetryDelay(1000)).toBe(3000);
  });
});
