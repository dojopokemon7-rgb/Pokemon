/**
 * H-2 — per-account brute-force lockout: PURE decision logic (OWASP A07/A04).
 *
 * This module holds ONLY the side-effect-free decisions behind the account
 * lockout feature. It does NOT import Prisma, Redis, or better-auth, so it can
 * be unit-tested in isolation (AGENTS.md RULE 11). The single I/O caller is the
 * sign-in hook in `src/lib/auth.ts` — that hook reads/writes the two `User`
 * columns (`failedLoginAttempts`, `lockedUntil`); THIS file only computes what
 * those columns should become.
 *
 * The feature: count CONSECUTIVE failed email/password sign-ins per account.
 * Once the count reaches a threshold, lock the account for a cooldown window —
 * so an online password-guessing attack is throttled to `THRESHOLD` guesses per
 * `COOLDOWN` instead of unlimited. A successful sign-in clears the counter.
 *
 * Both knobs are env-overridable (ops can tune without a code change) via the
 * same positive-integer-reader style as `src/lib/utils/rate-limit.ts`. They are
 * read through the exported reader functions (NOT captured in module-level
 * consts) so a test can set `process.env` and observe the override — matching
 * how `creditTier()` is tested in `rate-limit.test.ts`.
 */

/** Reads a positive-integer env override, else the baked-in default. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Consecutive-failure threshold. Default 5 — the common OWASP-aligned value:
 * high enough to tolerate honest typos / a forgotten password, low enough to
 * stop online guessing. Override with env `LOCKOUT_THRESHOLD`.
 */
export function lockoutThreshold(): number {
  return envInt("LOCKOUT_THRESHOLD", 5);
}

/**
 * Cooldown length in MILLISECONDS. Default 15 minutes — long enough to make
 * brute-forcing impractical (THRESHOLD guesses per cooldown) while a legitimate
 * user who truly forgot can wait briefly or use the existing reset flow.
 * Override with env `LOCKOUT_COOLDOWN_MINUTES` (a positive integer count of
 * minutes).
 */
export function lockoutCooldownMs(): number {
  return envInt("LOCKOUT_COOLDOWN_MINUTES", 15) * 60 * 1000;
}

/**
 * The user-facing message shown when a locked account is rejected at sign-in.
 *
 * SECURITY: it MUST NOT reveal whether the submitted password was correct —
 * both a right and a wrong password on a locked account get this identical
 * message, so the lock leaks no credential-validity signal.
 */
export const LOCKOUT_MESSAGE =
  "Account temporarily locked due to too many failed attempts. Try again later.";

/** The two lockout columns as the hook reads/writes them. */
export interface LockoutState {
  failedLoginAttempts: number;
  lockedUntil: Date | null;
}

/**
 * Is the account currently locked? True IFF `lockedUntil` is a real date
 * STRICTLY in the future relative to `now` (a lock that expired exactly at
 * `now` is no longer in effect). Used by the `before` sign-in hook.
 */
export function isLocked(lockedUntil: Date | null | undefined, now: Date): boolean {
  return lockedUntil instanceof Date && lockedUntil.getTime() > now.getTime();
}

/**
 * Compute the next state after a FAILED credential sign-in.
 *
 * Increments the attempt counter. If the incremented count REACHES the
 * threshold, stamp `lockedUntil = now + cooldown` and CLAMP the counter at the
 * threshold (it does not keep climbing once locked — every further failed
 * attempt just re-stamps the cooldown from `now`, so hammering a locked account
 * keeps extending the lock rather than overflowing the counter). Below the
 * threshold, `lockedUntil` stays null.
 */
export function nextFailureState(current: LockoutState, now: Date): LockoutState {
  const threshold = lockoutThreshold();
  const incremented = current.failedLoginAttempts + 1;

  if (incremented >= threshold) {
    return {
      failedLoginAttempts: threshold, // clamp — don't climb past the threshold
      lockedUntil: new Date(now.getTime() + lockoutCooldownMs()),
    };
  }

  return { failedLoginAttempts: incremented, lockedUntil: null };
}

/**
 * The state after a SUCCESSFUL sign-in: counter reset, lock cleared. Returned
 * fresh each call (never a shared mutable object).
 */
export function resetState(): LockoutState {
  return { failedLoginAttempts: 0, lockedUntil: null };
}
