/**
 * Admin login guard (M-2) — DURABLE, NON-REDIS brute-force floor. SERVER-ONLY.
 *
 * WHY: the only limiter on the admin login routes is the Redis, per-IP,
 * fail-open `authTier`. With Redis down (or IPs rotated) admin password guesses
 * were unbounded, and every CORRECT password minted a fresh nonce with a fresh
 * 5-guess OTP budget (plus an email). This module adds three GLOBAL counters
 * (single env-defined admin identity => not per-IP, so rotating IPs does not
 * help), kept in Postgres so they survive restarts and are shared by every
 * container:
 *
 *   password  — attempts at the password step         (max 5  / 15 min)
 *   mint      — OTP challenges minted (= OTP emails)  (max 5  / 15 min)
 *   otp       — OTP guesses across ALL nonces         (max 10 / 15 min)
 *
 * Each is a FIXED-WINDOW counter: the first hit opens a 15-minute window; hits
 * beyond the max inside it are refused; when the window ends the counter starts
 * over. "Reserve first, decide on the returned count" (one atomic UPSERT
 * statement) means a parallel burst cannot overshoot the cap — there is no
 * check-then-increment gap.
 *
 * RECOVERY / MAX LOCK: a lock is simply "window not yet over" => at most 15
 * minutes from the window's first hit. Attempts made while locked do NOT extend
 * it (expiresAt is only set when a window opens), so the admin is never
 * permanently locked and the correct credential is usable again within <= 15
 * min. A completed password+OTP login resets all three counters at once.
 * TRADEOFF (accepted, documented): a sustained attacker who burns the 5-attempt
 * budget every window keeps the admin in cooldown for as long as they keep
 * attacking; the price for that is the same 5 guesses/15 min (480/day) at
 * the password and nothing more. Break-glass for the operator:
 *   DELETE FROM verification WHERE id LIKE 'admin-guard:%';
 *
 * STORAGE (no migration): rows in the EXISTING `verification` table
 * (id = identifier = "admin-guard:<name>", value = count as text, expiresAt =
 * window end). `id` is the primary key, so INSERT ... ON CONFLICT (id) gives
 * atomic increments with no new table or columns. Better Auth only touches
 * rows by its own identifiers, and nothing in this repo purges the table.
 *
 * FAIL-SAFE (RULE 1 spirit): if the DB call throws, we log LOUDLY and fall back
 * to an in-process counter with the same semantics — a DB hiccup never throws
 * out of the login route and never locks the admin out; the floor degrades to
 * per-process (resets on restart) instead of vanishing.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";

export const ADMIN_GUARD_WINDOW_MS = 15 * 60 * 1000;
export const ADMIN_GUARD_MAX = { password: 5, mint: 5, otp: 10 } as const;
export type AdminGuardKind = keyof typeof ADMIN_GUARD_MAX;

const KEY = (k: AdminGuardKind) => `admin-guard:${k}`;
const ALL_KEYS = (Object.keys(ADMIN_GUARD_MAX) as AdminGuardKind[]).map(KEY);

type GuardDb = Pick<PrismaClient, "$queryRaw" | "verification">;

// ---- in-process fallback (same fixed-window semantics) ----
const mem = new Map<string, { count: number; resetsAt: number }>();
function memHit(key: string, now: number): number {
  const cur = mem.get(key);
  if (!cur || cur.resetsAt <= now) {
    mem.set(key, { count: 1, resetsAt: now + ADMIN_GUARD_WINDOW_MS });
    return 1;
  }
  cur.count += 1;
  return cur.count;
}
/** TEST ONLY: clears the in-process fallback counters. */
export function __resetAdminGuardMemoryForTests(): void {
  mem.clear();
}

/** Atomically records one hit; returns the count inside the current window. */
async function hit(kind: AdminGuardKind, db: GuardDb): Promise<number> {
  const key = KEY(kind);
  try {
    const rows = await db.$queryRaw<{ count: number }[]>`
      INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt")
      VALUES (${key}, ${key}, '1',
              (NOW() AT TIME ZONE 'UTC') + (${ADMIN_GUARD_WINDOW_MS}::double precision * INTERVAL '1 millisecond'),
              NOW() AT TIME ZONE 'UTC', NOW() AT TIME ZONE 'UTC')
      ON CONFLICT ("id") DO UPDATE SET
        "value" = CASE WHEN "verification"."expiresAt" <= (NOW() AT TIME ZONE 'UTC')
                       THEN '1' ELSE (("verification"."value")::int + 1)::text END,
        "expiresAt" = CASE WHEN "verification"."expiresAt" <= (NOW() AT TIME ZONE 'UTC')
                           THEN (NOW() AT TIME ZONE 'UTC') + (${ADMIN_GUARD_WINDOW_MS}::double precision * INTERVAL '1 millisecond')
                           ELSE "verification"."expiresAt" END,
        "updatedAt" = NOW() AT TIME ZONE 'UTC'
      RETURNING ("value")::int AS "count"`;
    const n = Number(rows[0]?.count);
    if (!Number.isFinite(n)) throw new Error("admin-guard: no count returned");
    return n;
  } catch (err) {
    console.error(
      "[admin-guard] DURABLE STORE UNAVAILABLE — falling back to the in-process counter " +
        "(per-process, resets on restart). Investigate the database:",
      err
    );
    return memHit(key, Date.now());
  }
}

export interface GuardDecision {
  allowed: boolean;
  count: number;
}
async function reserve(kind: AdminGuardKind, db: GuardDb): Promise<GuardDecision> {
  const count = await hit(kind, db);
  return { allowed: count <= ADMIN_GUARD_MAX[kind], count };
}

/** Reserve one admin password attempt (call BEFORE acting on the compare result). */
export const reserveAdminPasswordAttempt = (db: GuardDb = prisma) => reserve("password", db);
/** Reserve one OTP challenge mint (== one OTP email). */
export const reserveAdminOtpMint = (db: GuardDb = prisma) => reserve("mint", db);
/** Reserve one OTP guess, counted across all nonces. */
export const reserveAdminOtpAttempt = (db: GuardDb = prisma) => reserve("otp", db);

/** Full password+OTP login succeeded: clear every counter. Never throws. */
export async function resetAdminGuard(db: GuardDb = prisma): Promise<void> {
  mem.clear();
  try {
    await db.verification.deleteMany({ where: { id: { in: ALL_KEYS } } });
  } catch (err) {
    console.error("[admin-guard] reset failed (counters expire on their own within 15 min):", err);
  }
}
