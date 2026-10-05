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
 *   - `redis://redis:6379`     in Docker Compose (uses service name) — NO TLS
 *   - `redis://localhost:6379` for local development without Docker — NO TLS
 *   - `rediss://default:<password>@<host>.upstash.io:6379` on Vercel/Upstash — TLS
 *
 * TLS: the `rediss://` scheme (or an `*.upstash.io` host) enables TLS via
 * `tls: {}`; plain `redis://` stays plaintext. ioredis does not reliably enable
 * TLS from the scheme alone on Vercel serverless, so we set it explicitly — see
 * shouldUseTls() in src/lib/utils/redis-tls.ts.
 *
 * Fail-open hardening (AGENTS.md RULE 1 — a Redis outage must NEVER break a
 * request): `enableOfflineQueue: false` + `maxRetriesPerRequest: 1` make a
 * command fail FAST on a dead/unreachable server so callers fall through to
 * Postgres instead of blocking the serverless function on a queued command.
 */

import Redis from "ioredis";
import { shouldUseTls } from "@/lib/utils/redis-tls";

// Extend global to hold the singleton across Next.js hot reloads
const globalForRedis = globalThis as unknown as {
  redis: Redis | undefined;
};

function createRedisClient(): Redis {
  // STORAGE_REDIS_URL is the name Vercel's Upstash/Redis integration auto-injects;
  // REDIS_URL is what local/Docker use. Accept either so the same code runs in both.
  const redisUrl = process.env.REDIS_URL ?? process.env.STORAGE_REDIS_URL;

  if (!redisUrl) {
    throw new Error(
      "REDIS_URL environment variable is not set. " +
        "Set it to `redis://localhost:6379` for local dev, `redis://redis:6379` inside Docker, " +
        "or `rediss://default:<password>@<host>.upstash.io:6379` for Vercel/Upstash (TLS)."
    );
  }

  const useTls = shouldUseTls(redisUrl);

  const client = new Redis(redisUrl, {
    // Fail-open fast (AGENTS.md RULE 1): don't queue commands against a dead
    // socket — fail the command so callers fall through to Postgres.
    enableOfflineQueue: false,
    // Cap the time a single command waits on a command/connect before failing,
    // so a serverless invocation never blocks on an unreachable Redis.
    connectTimeout: 10000,
    maxRetriesPerRequest: 1,
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
    // TLS last: rediss:// / Upstash host ⇒ TLS; plain redis:// ⇒ plaintext.
    ...(useTls ? { tls: {} } : {}),
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

  /**
   * eBay Application Access Token (Client Credentials grant).
   * TTL: 7000 seconds — 200s of safety margin before eBay's 7200s expiry.
   * Single key, one token per app (no per-user personalisation).
   */
  ebayAppToken: "ebay:app-token",

  /**
   * Cached eBay Browse API search result, keyed by lowercased query.
   * TTL: 24 hours — protects our client's daily eBay rate limits.
   */
  ebaySearch: (query: string): string =>
    `ebay:search:${query.toLowerCase().trim()}`,

  /**
   * Cached "Sellers on the Floor" listings for a card detail page.
   * TTL: 1 hour (listings change, but not every request needs a live call).
   */
  ebaySold: (key: string): string => `ebay:sold:${key.toLowerCase().trim()}`,

  /**
   * Cached daily FX rates keyed by base currency (e.g. "USD", "JPY").
   * TTL: 24 hours. Used ONLY to convert a current-price display into the
   * user's profile currency (USD/EUR); history chart points are never
   * converted. A cache miss / Redis outage falls through to a live fetch,
   * and a live-fetch failure surfaces as "conversion unavailable" (never a
   * fabricated converted number) — see fx.service.ts.
   */
  fxRates: (base: string): string => `fx:rates:${base.toUpperCase().trim()}`,

  /**
   * Scrydex live-credit approval gate. When a value is present, an owner has
   * approved live Scrydex credit spend up to the stored budget. Absent =
   * NOT approved; credit-consuming calls must refuse. See scrydex-credit-gate.ts.
   */
  scrydexCreditApproval: "scrydex:credit-approval",

  // ===========================================================
  // Server-side data caches (fail-open, CACHE-ONLY — AGENTS.md RULE 1).
  // Every reader/writer wraps redis in try/catch and falls through to the
  // live Postgres query on ANY error. Nothing here is a source of truth.
  // ===========================================================

  /**
   * Dashboard SSR payload (owned rows + named collections) for one user.
   * PER-USER (RULE 5 — key embeds userId; a key without it would leak one
   * user's private collection to another). TTL: 90s (CACHE_TTL.dashboard).
   * INVALIDATED BY: add/sell/update/delete collection item, want-list
   * add/move/remove, and collection create/rename/delete (dashboard reflects
   * both collection values and want counts).
   */
  dashboardData: (userId: string): string => `dashboard:${userId}`,

  /**
   * `GET /api/users/me/collection` payload for one user.
   * PER-USER (RULE 5). TTL: 90s (CACHE_TTL.userCollection).
   * INVALIDATED BY: add/sell/update/delete collection item.
   */
  userCollection: (userId: string): string => `collection:${userId}`,

  /**
   * `GET /api/want-list` payload for one user, scoped by intent tab.
   * PER-USER (RULE 5). `intent` is BUY|SELL|TRADE, or "all" when the request
   * omits it. TTL: 60s (CACHE_TTL.wantList). The suffix is built so a future
   * collectionId scope can extend it without colliding with existing keys —
   * NOT implemented here.
   * INVALIDATED BY: want-list add/move/remove (whole family — see
   * wantListPattern — so a move between tabs can't leave a stale intent list).
   */
  wantList: (userId: string, intent?: string): string =>
    `wantlist:${userId}:${intent ?? "all"}`,

  /**
   * Glob pattern matching every want-list intent key for one user. Used by
   * invalidateUserCaches to drop the whole family (all intents + "all") on
   * any want-list mutation. PER-USER (RULE 5).
   */
  wantListPattern: (userId: string): string => `wantlist:${userId}:*`,

  /**
   * `GET /api/collections` payload (the user's named collections list).
   * PER-USER (RULE 5). TTL: 60s (CACHE_TTL.collections).
   * INVALIDATED BY: collection create/rename/delete.
   */
  collections: (userId: string): string => `collections:${userId}`,

  /**
   * `GET /api/cards/search` result, keyed by the fully-normalized query
   * params. USER-AGNOSTIC (RULE 3 — the catalog result is identical for
   * everyone; NO userId, sharing it is the point). Distinct from the
   * service-layer `cardSearch` 24h key above. TTL: 300s (CACHE_TTL.cardSearch).
   * Only non-empty 200s are cached (a mid-sync empty result isn't pinned).
   */
  cardSearchResult: (params: {
    game: string;
    query: string;
    sort: string;
    set?: string;
    rarity?: string;
    graded?: string;
    minPrice?: number;
    maxPrice?: number;
  }): string => {
    // Stable, order-independent key=value join; query lowercased to match the
    // existing lowercase search convention so ?query=Char and ?query=char hit
    // the same entry.
    const parts = [
      `game=${params.game}`,
      `q=${params.query.toLowerCase().trim()}`,
      `sort=${params.sort}`,
      `set=${params.set ?? ""}`,
      `rarity=${params.rarity ?? ""}`,
      `graded=${params.graded ?? ""}`,
      `min=${params.minPrice ?? ""}`,
      `max=${params.maxPrice ?? ""}`,
    ];
    return `card:searchq:${parts.join("|")}`;
  },

  /**
   * `GET /api/cards/[id]/prices` payload, keyed by EXTERNAL card id (RULE 3 —
   * `[id]` is the catalog externalId, not the internal cuid).
   * USER-AGNOSTIC. TTL: 300s (CACHE_TTL.cardPrices). DB-read-only; NO Scrydex.
   */
  cardPrices: (externalId: string): string => `card:prices:${externalId}`,

  /**
   * `GET /api/cards/[id]/history` payload, keyed by EXTERNAL card id (RULE 3).
   * USER-AGNOSTIC. TTL: 600s (CACHE_TTL.cardHistory). DB-read-only; NO Scrydex.
   */
  cardHistory: (externalId: string): string => `card:history:${externalId}`,

  /**
   * `GET /api/cards/[id]/population` payload, keyed by EXTERNAL card id
   * (RULE 3). USER-AGNOSTIC. TTL: 86400s (CACHE_TTL.cardPopulation — matches
   * the route's existing max-age=86400). READ of STORED population only; NO
   * live, credit-consuming Scrydex fetch.
   */
  cardPopulation: (externalId: string): string => `card:pop:${externalId}`,

  /**
   * `GET /api/cards/[id]/ebay-sold` payload (recent SOLD records), keyed by the
   * INTERNAL card id (cuid) the route resolves to. USER-AGNOSTIC (RULE 3 — the
   * sold set is identical for everyone). Postgres (SoldListing) is the SOURCE OF
   * TRUTH; this is a SHORT-TTL read-through (CACHE_TTL.soldRows = 120s) so a
   * burst of detail-page views doesn't re-query every time. DISTINCT from the
   * legacy `ebaySold` key (the old Redis-only credit-gated cache): that key is
   * left to age out on its own TTL and is NO LONGER read or written by the
   * route. INVALIDATED BY: pullAndStoreSoldListings (best-effort redis.del after
   * a store so a refresh shows before the 120s TTL expires).
   */
  soldRows: (cardId: string): string => `card:soldrows:${cardId}`,
} as const;

/**
 * TTLs (seconds) for the server-side data caches above. Imported by name so
 * routes never hardcode a magic number. Short for mutable per-user data (tiny
 * stale window), medium for public card data.
 */
export const CACHE_TTL = {
  dashboard: 90,
  userCollection: 90,
  wantList: 60,
  collections: 60,
  cardSearch: 300, // 5 min
  cardPrices: 300, // 5 min
  cardHistory: 600, // 10 min
  cardPopulation: 86400, // 24h — matches the route's existing max-age=86400
  soldRows: 120, // 2 min — short read-through; Postgres (SoldListing) is truth
} as const;
