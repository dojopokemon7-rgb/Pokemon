/**
 * Pure TLS-decision predicate for the Redis connection URL.
 *
 * `rediss://` (TLS scheme) or any Upstash host (`*.upstash.io`) ⇒ TLS.
 * Plain `redis://` local/Docker (`localhost`, `redis:6379`) ⇒ no TLS.
 *
 * Side-effect-free so it can be unit-tested in isolation (AGENTS.md RULE 11).
 */
export function shouldUseTls(url: string): boolean {
  return url.startsWith("rediss://") || /\.upstash\.io/i.test(url);
}

/**
 * Strip credentials from a Redis URL for safe logging (audit 12 F4).
 *
 * The Upstash/Docker form is `rediss://default:<password>@host:port`, so logging
 * the raw URL leaks the password to stdout and every log drain on each
 * (re)connect. Returns a `scheme://host:port/path` form with the `user:password@`
 * userinfo removed. On any parse failure (a non-URL connection string) returns a
 * constant placeholder — it NEVER returns the raw input, so a password can't leak
 * through the error path. Side-effect-free (AGENTS.md RULE 11).
 */
export function redactRedisUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "<redis-url>";
  }
}

/** Upper bound on the reconnect backoff (ms). */
const RETRY_DELAY_CAP_MS = 3000;

/**
 * ioredis `retryStrategy` delay for reconnect attempt `times` (audit 12 F5).
 *
 * MUST NEVER return `null`. Returning `null` tells ioredis to STOP reconnecting
 * and ENDS the client permanently — but the module-level `cachedClient`
 * singleton keeps holding that dead client, so after a ~20-25s Redis blip every
 * later command fails fast FOREVER. That silently disables caching AND rate
 * limiting (the auth/credit tiers in rate-limit.ts stop limiting — a security
 * hole) AND the circuit breakers, until the process restarts.
 *
 * Instead we retry indefinitely with a CAPPED exponential backoff: early
 * attempts ramp (200ms, 400ms, 800ms…) and every attempt past the cap waits
 * `RETRY_DELAY_CAP_MS`, so the client reconnects on its own when Redis returns —
 * no process restart needed. Per-command behavior stays fail-open independently
 * (`enableOfflineQueue:false` + `maxRetriesPerRequest:1` make a command during
 * the outage fail FAST and fall through to Postgres — see redis.ts). This helper
 * only governs the RECONNECT loop. Side-effect-free (AGENTS.md RULE 11).
 */
export function redisRetryDelay(times: number): number {
  return Math.min(Math.pow(2, times) * 100, RETRY_DELAY_CAP_MS);
}
