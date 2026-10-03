/**
 * Scan allowance service (SERVER-ONLY) — enforces the per-account lifetime
 * successful-scan limit (plan §3).
 *
 * CONCURRENCY SAFETY: the increment is a single ATOMIC conditional UPDATE
 * (`updateMany where { id, scanCount < limit }`), so two scans racing in
 * parallel can never both slip past the ceiling — Postgres serialises the row
 * update and only one wins the last slot. There is NO read-then-write window.
 *
 * CONSUMPTION RULE: `reserveSuccessfulScan` is called ONLY after a scan has
 * actually produced a successful identification. A no-match / failed / invalid
 * scan never calls it, so the allowance is spent on successes only.
 *
 * The user is identified from the Better Auth server session by the caller; the
 * userId passed here is already trusted (never client-supplied).
 */
import { prisma } from "@/lib/db";
import { getScanLimit, remainingScans } from "@/lib/utils/scan-limit";

export interface ScanAllowance {
  used: number;
  limit: number;
  remaining: number;
}

/** Read the current allowance for a user (for pre-flight display / gating). */
export async function getScanAllowance(userId: string): Promise<ScanAllowance> {
  const limit = getScanLimit();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { scanCount: true },
  });
  const used = user?.scanCount ?? 0;
  return { used, limit, remaining: remainingScans(used, limit) };
}

/**
 * Atomically reserve one successful scan. Returns `{ ok: true, allowance }`
 * when the slot was granted (counter incremented), or `{ ok: false, allowance }`
 * when the user is already at the limit (no increment).
 *
 * The conditional updateMany guarantees `scanCount` can never exceed `limit`
 * even under concurrent requests: each call either increments exactly once or
 * matches zero rows (already at/over limit).
 */
export async function reserveSuccessfulScan(
  userId: string
): Promise<{ ok: boolean; allowance: ScanAllowance }> {
  const limit = getScanLimit();

  const res = await prisma.user.updateMany({
    where: { id: userId, scanCount: { lt: limit } },
    data: { scanCount: { increment: 1 } },
  });

  // Re-read the authoritative counter for an accurate allowance snapshot.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { scanCount: true },
  });
  const used = user?.scanCount ?? limit;
  const allowance: ScanAllowance = { used, limit, remaining: remainingScans(used, limit) };

  return { ok: res.count === 1, allowance };
}
