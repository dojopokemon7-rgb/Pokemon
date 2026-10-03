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
