/**
 * Scan allowance limit resolution (pure — no I/O).
 *
 * Plan §3: each account gets 10 SUCCESSFUL matches total (lifetime, not per
 * month). The ceiling is CONFIGURABLE for future paid tiers via the `SCAN_LIMIT`
 * env var. A no-match / failed scan does NOT consume the allowance — that rule
 * lives at the call site (only a successful identify increments the counter).
 *
 * Resolution is defensive: an unset / empty / non-numeric / negative env value
 * falls back to the default so a misconfiguration can never silently grant
 * unlimited scans or zero them out unexpectedly.
 */

export const DEFAULT_SCAN_LIMIT = 10;

/**
 * Resolve the configured lifetime successful-scan limit from a raw env value.
 * Pure + exported so it can be unit-tested without touching process.env.
 */
export function resolveScanLimit(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_SCAN_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return DEFAULT_SCAN_LIMIT;
  return n;
}

/** Convenience reader for the live env value. */
export function getScanLimit(): number {
  return resolveScanLimit(process.env.SCAN_LIMIT);
}

/** Remaining successful scans for a given used count (never negative). */
export function remainingScans(used: number, limit = getScanLimit()): number {
  return Math.max(0, limit - Math.max(0, used));
}
