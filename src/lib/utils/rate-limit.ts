/**
 * Redis-backed, per-IP / per-user, FAIL-OPEN rate limiter.
 *
 * Protects the Scrydex-credit routes, search, and the Better Auth sign-in/
 * sign-up endpoints from abusive bursts without ever BLOCKING a request when
 * the cache is unavailable.
 *
 * AGENTS.md RULE 1 (Redis is OPTIONAL, FAIL-OPEN) is non-negotiable here: every
 * Redis call is wrapped in try/catch and ANY error (Redis offline, timeout,
 * malformed reply) results in the request being ALLOWED (warn-log, return
 * null). A cache outage disables rate limiting; it never turns into a 429.
 * This mirrors the house style in `src/lib/utils/cache.ts`.
 *
 * Algorithm: a FIXED-WINDOW counter — `INCR` the per-identity key, and on the
 * first hit (count === 1) set the key's TTL to the window length. `INCR` is
 * atomic, so the count is correct under concurrency; the first caller to create
 * the key owns setting its TTL.
 *
 * ponytail: fixed-window burst-at-boundary is the known ceiling — a client can
 * send up to `limit` requests at the end of one window and `limit` more at the
 * start of the next (≈2× over a window straddle). Accepted: the goal is to cap
 * sustained credit/DB abuse, not to be a precise sliding-window quota. Upgrade
 * path: a sorted-set + Lua sliding-window if precise per-window caps are ever
 * required.
 */

import { NextResponse } from "next/server";
import { redis, RedisKeys } from "@/lib/redis";

/** One rate-limit tier: a named bucket, its max count, and its window (= TTL). */
export type RateLimitTier = {
  /** Redis key bucket name, e.g. "credit" | "auth" | "search". */
  bucket: string;
  /** Max requests allowed within the window. */
  limit: number;
  /** Window length in seconds (also the Redis key TTL). */
  windowSeconds: number;
};

/** Who the counter is keyed by: an authenticated user id, or a client IP. */
export type RateLimitIdentity =
  | { kind: "user"; id: string }
  | { kind: "ip"; id: string };

/** Fixed 60s window for all tiers — keeps the knobs to per-minute counts only. */
const WINDOW_SECONDS = 60;

/** Reads a positive-integer env override, else the baked-in default. */
function envLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** VERY TIGHT — Scrydex-credit routes, per user. Default 10/min. */
export function creditTier(): RateLimitTier {
  return { bucket: "credit", limit: envLimit("RATELIMIT_CREDIT_PER_MIN", 10), windowSeconds: WINDOW_SECONDS };
}

/** TIGHT — auth sign-in/sign-up, per IP. Default 10/min. */
export function authTier(): RateLimitTier {
  return { bucket: "auth", limit: envLimit("RATELIMIT_AUTH_PER_MIN", 10), windowSeconds: WINDOW_SECONDS };
}

/** MODERATE — card search, per user if authed else per IP. Default 60/min. */
export function searchTier(): RateLimitTier {
  return { bucket: "search", limit: envLimit("RATELIMIT_SEARCH_PER_MIN", 60), windowSeconds: WINDOW_SECONDS };
}

/**
 * Resolves the real client IP. The app sits behind a proxy (Vercel/DigitalOcean/
 * Caddy), so the socket IP is the proxy — and the App Router `Request` has no
 * reliable socket IP anyway. We trust the FIRST hop of `x-forwarded-for` (the
 * original client as recorded by our edge), falling back to `x-real-ip`, then a
 * literal `"unknown"`.
 *
 * ponytail: when NO proxy header is present (bare local/test setup) every
 * unauthenticated caller shares the single `"unknown"` bucket. Accepted —
 * production always sets the proxy header, and the authed routes key by user id.
 */
export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get("x-real-ip");
  if (real && real.trim()) return real.trim();
  return "unknown";
}

/** Builds the per-identity Redis key: ratelimit:<bucket>:<u:id|ip:id>. */
function keyFor(tier: RateLimitTier, identity: RateLimitIdentity): string {
  const prefix = identity.kind === "user" ? "u" : "ip";
  return RedisKeys.rateLimit(tier.bucket, `${prefix}:${identity.id}`);
}

/** The 429 response (over-limit). `retryAfter` is the seconds to window reset. */
function tooManyRequests(retryAfter: number): NextResponse {
  return NextResponse.json(
    {
      error: "Too Many Requests",
      message: `Rate limit exceeded. Try again in ${retryAfter}s.`,
    },
    { status: 429, headers: { "Retry-After": String(retryAfter) } }
  );
}

/**
 * FAIL-OPEN rate-limit check. Returns a 429 `NextResponse` when `identity` has
 * exceeded `tier.limit` within `tier.windowSeconds`, otherwise `null` (allowed).
 *
 * ANY Redis error → `null` (allowed) + a warn log — a cache outage NEVER blocks.
 */
export async function enforceRateLimit(
  request: Request,
  tier: RateLimitTier,
  identity: RateLimitIdentity
): Promise<NextResponse | null> {
  // The ENTIRE check is inside one try/catch so ANY failure — Redis down, a
  // malformed reply, even a missing key builder — falls open (RULE 1). The key
  // build is included deliberately: nothing in this path may throw to a caller.
  try {
    const key = keyFor(tier, identity);

    // INCR is atomic → correct count under concurrency. On the FIRST hit the
    // key is new, so set its TTL to the window length (the pipeline keeps the
    // INCR and the one-shot EXPIRE on the same round-trip). "NX" means we only
    // ever set the TTL once per window, so a mid-window hit can't extend it.
    const results = await redis
      .multi()
      .incr(key)
      .expire(key, tier.windowSeconds, "NX")
      .exec();
    // multi().exec() → [[err, value], ...]; the INCR value is results[0][1].
    const incrResult = results?.[0]?.[1];
    const count = typeof incrResult === "number" ? incrResult : Number(incrResult);
    if (!Number.isFinite(count)) {
      // Unexpected reply shape — fail open rather than guess.
      console.warn(`[rate-limit] non-numeric INCR reply for "${key}", falling open`);
      return null;
    }

    if (count <= tier.limit) return null;

    // Over the limit → 429. Retry-After is the seconds until the window resets;
    // read the live TTL (best-effort) and fall back to the full window.
    let retryAfter = tier.windowSeconds;
    try {
      const ttl = await redis.ttl(key);
      if (typeof ttl === "number" && ttl > 0) retryAfter = ttl;
    } catch {
      /* TTL read failed — fall back to the full window length. */
    }
    return tooManyRequests(retryAfter);
  } catch (err) {
    console.warn(
      "[rate-limit] check failed, falling open (allowed):",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
