/**
 * Fail-open Redis cache helpers (AGENTS.md RULE 1 — Redis is CACHE-ONLY,
 * OPTIONAL, FAIL-OPEN).
 *
 * Every function here swallows ANY Redis error (offline, timeout, malformed
 * payload) and warn-logs it, so a cache fault NEVER propagates to the caller:
 *   - cacheGetJson → resolves to `null` (a miss) → caller runs the live query.
 *   - cacheSetJson → best-effort; a failed write never fails the request.
 *   - invalidateUserCaches → best-effort; a failed delete never fails a
 *     mutation (only costs one later cache miss).
 *
 * Nothing cached here is a source of truth — every value is reconstructable
 * from Postgres. This centralizes the get/set/del wrappers so a read key and
 * its invalidation can never drift (the single invalidateUserCaches owns the
 * per-user delete sets).
 */

import { redis, RedisKeys } from "@/lib/redis";

/**
 * Read + JSON.parse a cached value, fail-open. Returns `null` on a miss, a
 * Redis error, OR a malformed/legacy payload (the JSON.parse is inside the
 * try/catch, so a bad payload is treated as a miss → live fall-through, never
 * served). Callers that have an output Zod schema should re-validate the
 * returned value and treat a parse failure as a miss too.
 */
export async function cacheGetJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await redis.get(key);
    if (raw == null) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(
      `[cache] read failed for "${key}", falling through:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/**
 * Best-effort write of a JSON-serialized value with a TTL (seconds). A Redis
 * outage here doesn't invalidate the fresh live result the caller is about to
 * return — it just means the next request is another miss.
 */
export async function cacheSetJson(
  key: string,
  value: unknown,
  ttlSeconds: number
): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch (err) {
    console.warn(
      `[cache] write failed for "${key}" (non-fatal):`,
      err instanceof Error ? err.message : err
    );
  }
}

/** Per-user cache scopes a mutation can invalidate. */
export type CacheScope = "collection" | "dashboard" | "wantlist" | "collections";

/**
 * Best-effort invalidation of a user's cache keys for the given scopes. Called
 * on the WRITE path AFTER the DB write commits, so a failed delete never fails
 * the mutation but keeps the stale window minimal.
 *
 * Mutation → scopes mapping (also documented at each call site + in
 * docs/ARCHITECTURE.md §Redis keys):
 *   - add/sell/update/delete collection item → { collection, dashboard }
 *   - want-list add/move/remove              → { wantlist, dashboard }
 *   - collection create/rename/delete        → { collections, dashboard }
 */
export async function invalidateUserCaches(
  userId: string,
  scopes: CacheScope[]
): Promise<void> {
  try {
    const keys: string[] = [];
    if (scopes.includes("collection")) keys.push(RedisKeys.userCollection(userId));
    if (scopes.includes("dashboard")) keys.push(RedisKeys.dashboardData(userId));
    if (scopes.includes("collections")) keys.push(RedisKeys.collections(userId));

    if (scopes.includes("wantlist")) {
      // The want-list family spans one key per intent (BUY/SELL/TRADE) plus
      // "all". Drop them all so a move between tabs can't leave a stale list.
      // ponytail: redis.keys(pattern) is O(keyspace) and blocks Redis while it
      // scans — fine at dev/single-tenant scale. Upgrade to SCAN or tagged-set
      // invalidation if the keyspace grows large.
      try {
        const family = await redis.keys(RedisKeys.wantListPattern(userId));
        keys.push(...family);
      } catch (err) {
        console.warn(
          `[cache] want-list family scan failed for "${userId}" (non-fatal):`,
          err instanceof Error ? err.message : err
        );
      }
    }

    if (keys.length > 0) await redis.del(...keys);
  } catch (err) {
    console.warn(
      `[cache] invalidation failed for user "${userId}" (non-fatal):`,
      err instanceof Error ? err.message : err
    );
  }
}
