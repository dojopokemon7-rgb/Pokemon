import { describe, it, expect } from "vitest";
import { shouldUseTls } from "@/lib/utils/redis-tls";

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
