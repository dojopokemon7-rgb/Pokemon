/**
 * Admin login guard (M-2 + S-2) — DURABLE, NON-REDIS brute-force floor. SERVER-ONLY.
 *
 * WHY: the only limiter on the admin login routes is the Redis, per-IP,
 * fail-open `authTier`. With Redis down (or IPs rotated) admin password guesses
 * were unbounded, and every CORRECT password minted a fresh nonce with a fresh
 * 5-guess OTP budget (plus an email). This module keeps Postgres-backed counters
 * that survive restarts and are shared by every container.
 *
 * S-2 (unauthenticated lockout DoS): the first M-2 design had ONE global
 * password counter (5 / 15 min), so ANY anonymous client could lock the real
 * admin out with 5 wrong passwords, repeatably. It is now TWO-LEVEL:
 *
 *   password:ip:<ip> — per-SOURCE (clientIp())          max 5  / 15 min
 *   password         — GLOBAL ceiling (distributed cap)  max 40 / 15 min
 *   mint             — OTP challenges minted (= emails)  max 5  / 15 min  (global)
 *   otp              — OTP guesses across ALL nonces     max 10 / 15 min  (global)
 *
 * An IP over its own cap is refused WITHOUT touching the global counter, so one
 * flooding source locks only itself and cannot walk the global ceiling up. The
 * real admin, coming from another IP, still logs in.
 *
 * mint / otp stay global-only on purpose: reaching `mint` needs the CORRECT
 * password, and the otp counter is charged only for a request that carries a
 * currently-valid, unexpired nonce (verify-otp route; nonces are unguessable
 * UUIDs minted after the password step). A lone attacker without the password
 * therefore cannot move either of them.
 *
 * HONEST TRADEOFFS:
 *  (i)  Per-IP keys are only as trustworthy as clientIp(): CF-Connecting-IP is
 *       authoritative only while the origin firewall restricts 80/443 to
 *       Cloudflare (CD-1 in the earlier audit). If it is spoofable the per-IP
 *       level is bypassable (an attacker then just reaches the global ceiling);
 *       the global ceiling and the mint/otp caps still hold. Un-parseable IPs
 *       share one "unknown" bucket.
 *  (ii) A DISTRIBUTED attacker (>= 8 sources x 5 attempts) can still reach the
 *       global ceiling and deny the admin password step until that window ends
 *       (<= 15 min, repeatable by sustained effort). That is the price of a
 *       durable floor that does not rely on IP trust.
 *  Max password-guess rate: per source 5 / 15 min (480 / day); global
 *  40 / 15 min (3,840 / day) vs 5 / 15 min (480 / day) before. The global rate
 *  rose 8x because it is now the distributed-attack bound, not the single-
 *  client bound; ADMIN_PASSWORD must therefore be a long random secret.
 *
 * Each counter is a FIXED-WINDOW counter: the first hit opens a 15-minute
 * window; hits beyond the max inside it are refused; when the window ends the
 * counter starts over. "Reserve first, decide on the returned count" (one atomic
 * UPSERT statement) means a parallel burst cannot overshoot the cap.
 *
 * RECOVERY / MAX LOCK: a lock is "window not yet over" => at most 15 minutes
 * from the window's first hit; attempts while locked do NOT extend it. A
 * completed password+OTP login resets the global counters and the caller's own
 * IP row (other sources' rows are left alone). Break-glass for the operator:
 *   DELETE FROM verification WHERE id LIKE 'admin-guard:%';
 * (or scripts/clear-admin-guard.ts; see docs/ARCHITECTURE.md for how to run it).
 *
 * STORAGE (no migration): rows in the EXISTING `verification` table
 * (id = identifier = "admin-guard:<kind>[:ip:<ip>]", value = count as text,
 * expiresAt = window end). `id` is the primary key, so INSERT ... ON CONFLICT
 * (id) gives atomic increments. Expired rows are purged opportunistically on a
 * successful login.
 *
 * FAIL-SAFE (RULE 1 spirit): if the DB call throws, we log LOUDLY and fall back
 * to an in-process counter with the same semantics (per-source AND global) — a
 * DB hiccup never throws out of the login route and never locks the admin out;
 * the floor degrades to per-process (resets on restart) instead of vanishing.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";

export const ADMIN_GUARD_WINDOW_MS = 15 * 60 * 1000;
export const ADMIN_GUARD_MAX = { password: 40, mint: 5, otp: 10 } as const;
/** Per-source password cap (the only thing a lone anonymous client can exhaust). */
export const ADMIN_GUARD_MAX_PER_IP = 5;
export type AdminGuardKind = keyof typeof ADMIN_GUARD_MAX;

const KEY = (k: AdminGuardKind) => `admin-guard:${k}`;
const ALL_KEYS = (Object.keys(ADMIN_GUARD_MAX) as AdminGuardKind[]).map(KEY);
/** Well-formed IPv4/IPv6 text only (bounds row/memory growth from junk headers). */
const IP_RE = /^[0-9a-fA-F:.]{2,45}$/;
export const ipKey = (ip: string) =>
  `admin-guard:password:ip:${IP_RE.test(ip) ? ip.toLowerCase() : "unknown"}`;

type GuardDb = Pick<PrismaClient, "$queryRaw" | "verification">;

// ---- in-process fallback (same fixed-window semantics) ----
const mem = new Map<string, { count: number; resetsAt: number }>();
function memHit(key: string, now: number): number {
  if (mem.size > 1000) for (const [k, v] of mem) if (v.resetsAt <= now) mem.delete(k);
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

/** Atomically records one hit on `key`; returns the count inside the current window. */
async function hit(key: string, db: GuardDb): Promise<number> {
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
  const count = await hit(KEY(kind), db);
  return { allowed: count <= ADMIN_GUARD_MAX[kind], count };
}

/**
 * Reserve one admin password attempt (call BEFORE acting on the compare result).
 * Per-source first: an IP over its own cap is refused WITHOUT charging the global
 * ceiling. Otherwise the global ceiling is charged; it is the only level that can
 * refuse everyone, and it logs one warn line (no IPs/emails/secrets) when it
 * first trips.
 */
export async function reserveAdminPasswordAttempt(
  ip: string,
  db: GuardDb = prisma
): Promise<GuardDecision> {
  const perIp = await hit(ipKey(ip), db);
  if (perIp > ADMIN_GUARD_MAX_PER_IP) return { allowed: false, count: perIp };
  const global = await reserve("password", db);
  if (global.count === ADMIN_GUARD_MAX.password + 1) {
    console.warn(
      "[admin-guard] global admin password ceiling reached; password step refused for all sources until the window ends"
    );
  }
  return global;
}
/** Reserve one OTP challenge mint (== one OTP email). */
export const reserveAdminOtpMint = (db: GuardDb = prisma) => reserve("mint", db);
/** Reserve one OTP guess, counted across all nonces. Call only for a valid nonce. */
export const reserveAdminOtpAttempt = (db: GuardDb = prisma) => reserve("otp", db);

/**
 * Full password+OTP login succeeded: clear the global counters and THIS source's
 * row (other sources' rows are untouched), and purge expired guard rows.
 * Never throws.
 */
export async function resetAdminGuard(db: GuardDb = prisma, ip?: string): Promise<void> {
  const keys = ip === undefined ? ALL_KEYS : [...ALL_KEYS, ipKey(ip)];
  for (const k of keys) mem.delete(k);
  try {
    await db.verification.deleteMany({
      where: {
        OR: [
          { id: { in: keys } },
          { id: { startsWith: "admin-guard:" }, expiresAt: { lt: new Date() } },
        ],
      },
    });
  } catch (err) {
    console.error("[admin-guard] reset failed (counters expire on their own within 15 min):", err);
  }
}
