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
 * Resolves the real client IP. The app sits behind Cloudflare (proxied DNS) in
 * front of a Caddy reverse proxy; Caddy terminates every connection, so the
 * socket IP is always Caddy/Cloudflare and the App Router `Request` has no
 * reliable socket IP anyway.
 *
 * We trust `CF-Connecting-IP` FIRST. Once Cloudflare proxies the domain, the
 * TCP peer Caddy observes — and therefore the `x-real-ip` Caddy sets from
 * `{remote_host}` — is a CLOUDFLARE EDGE IP, not the visitor. That would
 * collapse every visitor into ONE per-IP rate-limit bucket. Cloudflare carries
 * the true visitor IP in `CF-Connecting-IP`, so that header is now the real
 * client key.
 *
 * SECURITY (AGENTS.md RULE 14 — load-bearing, do NOT strip): `CF-Connecting-IP`
 * is trustworthy ONLY because the Droplet firewall is locked so 80/443 accept
 * connections ONLY from Cloudflare's published IP ranges (the ufw step in
 * docs/CLOUDFLARE_SETUP.md). WITHOUT that firewall lock an attacker could reach
 * the origin IP directly and forge `CF-Connecting-IP` to rotate per-IP buckets
 * and brute-force past the cap on sign-in / email-OTP / admin-auth. WITH it,
 * every request is guaranteed to have transited Cloudflare, so Cloudflare sets
 * `CF-Connecting-IP` to the real visitor IP and it is authoritative. The
 * firewall range-lock is an OUT-OF-REPO operator step; it is what makes this
 * header safe to trust.
 *
 * When `CF-Connecting-IP` is ABSENT (local dev, tests, CI, or a non-Cloudflare
 * path) we keep the EXISTING chain unchanged: trust `x-real-ip` NEXT because
 * Caddy sets it from `{remote_host}` — the real TCP peer IP Caddy itself
 * observes — and OVERWRITES any client-supplied value, so it CANNOT be spoofed.
 * We must NOT trust the first hop of `x-forwarded-for`: Caddy forwards XFF by
 * default, APPENDING the real peer to whatever the client sent, so the FIRST
 * XFF hop is the attacker-CONTROLLED value. Keying the rate limiter on it let
 * an attacker rotate a forged XFF to get a fresh per-IP bucket on every request
 * and brute-force past the cap on sign-in / email-OTP / admin-auth
 * (audit 10 F2, 12 F8).
 *
 * Fallback chain for environments WITHOUT the proxy (local dev, tests, CI where
 * neither `CF-Connecting-IP` nor `x-real-ip` is set): fall back to the first
 * `x-forwarded-for` hop, then a literal `"unknown"` so those setups still get a
 * stable key. This degrades, never hard-fails (defense-in-depth; the Redis
 * layer is fail-open per RULE 1).
 *
 * ponytail: when NO proxy header is present (bare local/test setup) every
 * unauthenticated caller shares the single `"unknown"` bucket. Accepted —
 * production always sets `CF-Connecting-IP` (Cloudflare), and the authed routes
 * key by user id.
 */
export function clientIp(request: Request): string {
  // TRUSTED first: Cloudflare sets `CF-Connecting-IP` to the real visitor IP.
  // Safe ONLY because the Droplet firewall restricts 80/443 to Cloudflare's
  // published ranges (docs/CLOUDFLARE_SETUP.md) — without that lock the header
  // is spoofable; with it, every request transited Cloudflare so it's authoritative.
  const cf = request.headers.get("cf-connecting-ip");
  if (cf && cf.trim()) return cf.trim();
  // TRUSTED next (no Cloudflare header — local/dev/test/CI or direct Caddy):
  // Caddy's `header_up X-Real-IP {remote_host}` overwrites any client value with
  // the real peer IP — unspoofable in this single-proxy topology.
  const real = request.headers.get("x-real-ip");
  if (real && real.trim()) return real.trim();
  // UNTRUSTED fallback (no proxy): the first XFF hop is client-appended by Caddy,
  // so it's only used when x-real-ip is absent (local/dev/test/CI).
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
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
