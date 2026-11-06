/**
 * Account lockout I/O (H-2 + H-1 fix). SERVER-ONLY. Takes the Prisma client as a
 * parameter (auth.ts passes the singleton) so tests can drive it through
 * independent clients or mocks.
 *
 * H-1 fixes:
 *  - IDENTITY: every read/write uses `canonicalAuthEmail` (lowercase), exactly
 *    the row Better Auth authenticates. Exact match on the lowercased value (not
 *    lower(email)) keeps the unique index usable; a legacy mixed-case row could
 *    not sign in via Better Auth at all (its lookup is exact on lowercase), so
 *    there is nothing for a lockout to protect on it.
 *  - ATOMICITY: failed-attempt increment is ONE SQL statement (increment +
 *    threshold check + lock stamp), so concurrent failures serialise on the row
 *    lock and can never lose an update (the old code read, computed in JS, then
 *    wrote absolutes). Semantics equal `nextFailureState`: counter clamps at the
 *    threshold; reaching it stamps lockedUntil = now + cooldown (re-stamped on
 *    every further failure); below it lockedUntil is NULL. The lock time uses
 *    the DB clock in UTC (columns are naive-UTC timestamp(3)).
 *  - Unknown email -> 0 rows (no enumeration, no phantom row).
 */
import type { PrismaClient } from "@prisma/client";
import { APIError } from "better-auth/api";
import {
  LOCKOUT_MESSAGE,
  canonicalAuthEmail,
  isLocked,
  lockoutCooldownMs,
  lockoutThreshold,
  resetState,
} from "@/lib/utils/lockout";

type LockoutDb = Pick<PrismaClient, "user" | "$executeRaw">;

/** Atomically record one failed login. Returns rows updated (0 = unknown email). */
export async function recordFailedLogin(
  db: Pick<PrismaClient, "$executeRaw">,
  email: string
): Promise<number> {
  const threshold = lockoutThreshold();
  const cooldownMs = lockoutCooldownMs();
  return db.$executeRaw`
    UPDATE "user"
    SET "failedLoginAttempts" = LEAST("failedLoginAttempts" + 1, ${threshold}::int),
        "lockedUntil" = CASE
          WHEN "failedLoginAttempts" + 1 >= ${threshold}::int
          THEN (NOW() AT TIME ZONE 'UTC')
               + (${cooldownMs}::double precision * INTERVAL '1 millisecond')
          ELSE NULL END
    WHERE "email" = ${canonicalAuthEmail(email)}`;
}

/** The slice of a Better Auth hook ctx these handlers read. */
export interface SignInHookCtx {
  path?: string;
  body?: { email?: unknown } | null;
  context: { newSession?: unknown; returned?: unknown };
}

/**
 * BEFORE /sign-in/email: reject (FORBIDDEN, generic message) if the account is
 * locked. Fail-safe: a lookup error logs and lets the sign-in proceed.
 */
export async function lockoutBeforeSignIn(ctx: SignInHookCtx, db: LockoutDb): Promise<void> {
  if (ctx.path !== "/sign-in/email") return;
  const raw = ctx.body?.email;
  if (typeof raw !== "string" || raw.length === 0) return;
  const email = canonicalAuthEmail(raw);

  let lockedUntil: Date | null = null;
  try {
    const user = await db.user.findUnique({ where: { email }, select: { lockedUntil: true } });
    // No such user: normal INVALID_EMAIL_OR_PASSWORD flow (no enumeration).
    if (!user) return;
    lockedUntil = user.lockedUntil;
  } catch (err) {
    console.error("[auth] lockout before-hook lookup failed:", err);
    return;
  }
  if (isLocked(lockedUntil, new Date())) {
    // Deliberate throw: the lockout itself. Generic; never reveals pw validity.
    throw new APIError("FORBIDDEN", { message: LOCKOUT_MESSAGE });
  }
}

/**
 * AFTER /sign-in/email: success -> reset; INVALID_EMAIL_OR_PASSWORD -> atomic
 * increment. EMAIL_NOT_VERIFIED (password was correct) and any other outcome do
 * not count. DB errors are logged, never surfaced.
 */
export async function lockoutAfterSignIn(ctx: SignInHookCtx, db: LockoutDb): Promise<void> {
  if (ctx.path !== "/sign-in/email") return;
  const raw = ctx.body?.email;
  if (typeof raw !== "string" || raw.length === 0) return;
  const email = canonicalAuthEmail(raw);

  if (ctx.context.newSession) {
    try {
      // updateMany: a missing row is a 0-row no-op, never a throw.
      await db.user.updateMany({ where: { email }, data: resetState() });
    } catch (err) {
      console.error("[auth] lockout success-reset failed:", err);
    }
    return;
  }

  const returned = ctx.context.returned as { body?: { code?: string } } | undefined;
  if (returned?.body?.code !== "INVALID_EMAIL_OR_PASSWORD") return;
  try {
    await recordFailedLogin(db, email);
  } catch (err) {
    console.error("[auth] lockout failure-increment failed:", err);
  }
}
