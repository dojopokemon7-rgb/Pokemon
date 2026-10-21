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
