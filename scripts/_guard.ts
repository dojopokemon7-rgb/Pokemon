/**
 * Shared prod-DB write guard for the destructive one-off scripts
 * (backfill-prices, seed-pricing-history, snapshot-pokemon-prices).
 *
 * These scripts WRITE to whatever DATABASE_URL points at. Run against the
 * remote Supabase pooler by accident and they mutate production rows. This
 * guard makes a prod target require an explicit opt-in.
 */

/**
 * PURE predicate — true when DATABASE_URL/NODE_ENV look like a production
 * target. Side-effect-free so it can be unit-tested in isolation
 * (AGENTS.md RULE 11).
 *
 * ponytail: naive host-substring heuristic — a URL is "prod" when its host is
 * NOT localhost/127.0.0.1 (so e.g. *.pooler.supabase.com counts), OR when
 * NODE_ENV === 'production'. It does not parse the URL or match an allowlist of
 * known-safe hosts, so a non-local DB used purely for dev would read as prod.
 * Upgrade path if that bites: parse the host and check an explicit allowlist.
 * The CONFIRM_PROD_WRITE=true override below is the deliberate escape hatch.
 */
export function isProdDbTarget(
  databaseUrl: string | undefined,
  nodeEnv: string | undefined
): boolean {
  if (nodeEnv === "production") return true;
  if (!databaseUrl) return false;
  const isLocal = /(@|\/\/)(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl);
  return !isLocal;
}

/**
 * Side-effecting assertion — call at the TOP of a destructive script's entry
 * point. Throws (aborting the run) when the target looks like production and
 * the operator has not set CONFIRM_PROD_WRITE=true.
 */
export function assertSafeToWrite(): void {
  if (
    isProdDbTarget(process.env.DATABASE_URL, process.env.NODE_ENV) &&
    process.env.CONFIRM_PROD_WRITE !== "true"
  ) {
    throw new Error(
      "Refusing to write: DATABASE_URL/NODE_ENV looks like a PRODUCTION target. " +
        "Re-run with CONFIRM_PROD_WRITE=true if this is intentional."
    );
  }
}
