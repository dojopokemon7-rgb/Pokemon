/**
 * Redis Client (ioredis)
 *
 * A singleton ioredis client for the application.
 * Used for:
 *   - Session caching
 *   - OTP storage / rate limiting
 *   - General key-value caching (Week 3+)
 *
 * REDIS_URL is set to:
 *   - `redis://redis:6379`    in Docker Compose (uses service name)
 *   - `redis://localhost:6379` for local development without Docker
 */

import Redis from "ioredis";

// Extend global to hold the singleton across Next.js hot reloads
const globalForRedis = globalThis as unknown as {
  redis: Redis | undefined;
};

function createRedisClient(): Redis {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    throw new Error(
      "REDIS_URL environment variable is not set. " +
        "Set it to `redis://localhost:6379` for local dev or `redis://redis:6379` inside Docker."
    );
  }

  const client = new Redis(redisUrl, {
    // Automatically retry failed commands when Redis reconnects
    enableOfflineQueue: true,
    // Retry logic: exponential backoff, max 10 retries
    retryStrategy(times: number): number | null {
      if (times > 10) {
        console.error(
          "[Redis] Max retry attempts reached. Giving up on reconnection."
        );
        return null; // stop retrying
      }
      // Wait 2^times * 100ms between retries (100ms, 200ms, 400ms…)
      return Math.min(Math.pow(2, times) * 100, 3000);
    },
    lazyConnect: false,
  });

  client.on("connect", () => {
    console.log("[Redis] Connected to Redis at:", redisUrl);
  });

  client.on("error", (err: Error) => {
    console.error("[Redis] Connection error:", err.message);
  });

  client.on("reconnecting", () => {
    console.warn("[Redis] Reconnecting…");
  });

  return client;
}

// =============================================================
// Lazy client accessor
// =============================================================
//
// IMPORTANT: We must NOT construct the Redis client at module-import
// time. During `next build`, Next.js imports every route module to
// "collect page data" — this happens in the Docker builder stage,
// where REDIS_URL is NOT available. An eagerly-constructed client
// would throw at build time and fail the whole image build.
//
// The proxy below defers construction until a METHOD is actually
// invoked at request time (when REDIS_URL is guaranteed to be set).
// Plain property reads (e.g. instanceof checks) do not trigger
// construction, and consumers keep using `redis.get(...)` unchanged.
//
let cachedClient: Redis | undefined;

/** Lazily constructs (and caches) the real ioredis client. */
function getClient(): Redis {
  if (cachedClient) return cachedClient;
  cachedClient = globalForRedis.redis ?? createRedisClient();
  if (process.env.NODE_ENV !== "production") {
    globalForRedis.redis = cachedClient;
  }
  return cachedClient;
}

/**
 * Exported Redis client.
 *
 * Safe to import at build time — it only connects on first use.
 */
export const redis = new Proxy({} as Redis, {
  get(_target, prop: string | symbol) {
    const client = getClient();
    const value = (client as unknown as Record<string | symbol, unknown>)[prop];
    // Bind methods so `this` stays the ioredis instance.
    return typeof value === "function" ? value.bind(client) : value;
  },
}) as Redis;

// =============================================================
// Health Check Utility
// =============================================================

/**
 * Sends a PING command to Redis and expects "PONG" in response.
 * Use this in health check API routes or startup verification.
 *
 * @returns `true` if Redis is healthy, `false` otherwise.
 */
export async function pingRedis(): Promise<boolean> {
  try {
    const result = await redis.ping();
    return result === "PONG";
  } catch (error) {
    console.error("[Redis] Ping failed:", error);
    return false;
  }
}

// =============================================================
// Typed Key Helpers (add more as the app grows)
// =============================================================

export const RedisKeys = {
  /**
   * OTP verification code for a phone number.
   * TTL: 10 minutes (600 seconds)
   */
  otpCode: (phone: string): string => `otp:${phone}`,

  /**
   * Rate limit counter for OTP requests per phone number.
   * TTL: 1 hour (3600 seconds)
   */
  otpRateLimit: (phone: string): string => `otp:rate:${phone}`,

  /**
   * Cached card price by external card ID.
   * TTL: 6 hours (21600 seconds) — refreshed by the pricing cron job.
   */
  cardPrice: (externalId: string): string => `price:card:${externalId}`,

  /**
   * Cached normalized search result, keyed by game + query.
   * TTL: 24 hours (86400 seconds) — populated by card.service.ts on cache miss.
   *
   * @param game  `"pokemon"` | `"onepiece"`
   * @param query lowercased search term
   */
  cardSearch: (game: string, query: string): string =>
    `card:search:${game}:${query.toLowerCase().trim()}`,
} as const;
