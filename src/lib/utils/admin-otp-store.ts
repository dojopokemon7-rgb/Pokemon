/**
 * Admin login OTP store — in-memory, server-only.
 *
 * Mandatory email OTP on EVERY admin login. A challenge is keyed by a random
 * `loginNonce` (minted after the password passes, carried in a short-lived
 * httpOnly cookie) and holds the SHA-256 hash of a 6-digit code, an absolute
 * expiry, and a wrong-attempt counter.
 *
 * SECURITY: the plaintext code is returned ONCE from `createOtpChallenge` for
 * the sole purpose of emailing it; only its hash is stored. Codes are
 * single-use (deleted on success), expire after 10 minutes, and are locked out
 * after 5 wrong attempts (challenge cleared → the user must re-enter the
 * password). The code is never logged.
 *
 * ponytail: a module-level Map is correct for ONE admin on ONE Node instance —
 * the documented single-instance deployment. Upgrade path if the app ever runs
 * multiple instances: move this store to Redis keyed by the nonce (the shape —
 * {otpHash, exp, attempts} — ports directly), since a per-process Map would let
 * a challenge minted on instance A be unverifiable on instance B.
 */

import { createHash, randomInt } from "crypto";

/** 10-minute code validity — matches the user email-OTP envelope in auth.ts. */
const OTP_TTL_MS = 10 * 60 * 1000;
/** Lock the challenge after this many wrong guesses (forces password re-entry). */
const MAX_ATTEMPTS = 5;

interface Challenge {
  otpHash: string;
  exp: number; // epoch ms
  attempts: number;
}

const store = new Map<string, Challenge>();

function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/**
 * Generates a fresh 6-digit OTP for `nonce`, stores its hash + expiry, and
 * returns the PLAINTEXT code for emailing. Overwrites any existing challenge
 * for the nonce (a resend starts a clean 10-min window + attempt counter).
 *
 * `randomInt(0, 1_000_000)` is a cryptographically secure uniform draw; the
 * zero-pad keeps leading-zero codes (e.g. "000123") exactly 6 digits.
 */
export function createOtpChallenge(nonce: string): string {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  store.set(nonce, { otpHash: hashCode(code), exp: Date.now() + OTP_TTL_MS, attempts: 0 });
  // DEV/TEST ONLY: keep the plaintext for the gated e2e read seam. No-op in
  // production (the parallel map is never populated there).
  __rememberPlaintextForTests(nonce, code);
  return code;
}

export type OtpVerifyResult =
  | { ok: true }
  | { ok: false; reason: "expired" | "invalid" | "locked" | "unknown"; remaining?: number };

/**
 * Verifies `code` against the challenge for `nonce`.
 *
 * - unknown nonce → `{ ok:false, reason:"unknown" }`.
 * - expired → challenge cleared, `{ ok:false, reason:"expired" }`.
 * - correct → challenge cleared (single-use), `{ ok:true }`.
 * - wrong → attempts++; once it reaches MAX_ATTEMPTS the challenge is cleared
 *   and `{ ok:false, reason:"locked" }` is returned (re-enter password);
 *   otherwise `{ ok:false, reason:"invalid", remaining }`.
 *
 * `now` is injectable for deterministic expiry tests.
 */
export function verifyOtp(nonce: string, code: string, now: number = Date.now()): OtpVerifyResult {
  const challenge = store.get(nonce);
  if (!challenge) return { ok: false, reason: "unknown" };

  if (now >= challenge.exp) {
    store.delete(nonce);
    return { ok: false, reason: "expired" };
  }

  const match = challenge.otpHash === hashCode(code);
  if (match) {
    store.delete(nonce); // single-use
    return { ok: true };
  }

  challenge.attempts += 1;
  if (challenge.attempts >= MAX_ATTEMPTS) {
    store.delete(nonce);
    return { ok: false, reason: "locked" };
  }
  return { ok: false, reason: "invalid", remaining: MAX_ATTEMPTS - challenge.attempts };
}

/** Drops any challenge for `nonce` (e.g. on logout / password re-entry). */
export function clearChallenge(nonce: string): void {
  store.delete(nonce);
  devPlaintext.delete(nonce);
}

/**
 * DEV/TEST ONLY. Returns nothing in production. Used by the gated e2e OTP read
 * seam so Playwright can retrieve the current code for `nonce` against the
 * running server process (the code is NOT in the DB, so read-otp.ts can't see
 * it). Returns the plaintext only when NODE_ENV !== "production" AND the test
 * code set it; otherwise undefined.
 *
 * The store holds only the HASH, so there is nothing to peek by default. This
 * seam deliberately keeps a parallel plaintext map populated ONLY in non-prod.
 */
const devPlaintext = new Map<string, string>();

export function __rememberPlaintextForTests(nonce: string, code: string): void {
  if (process.env.NODE_ENV === "production") return;
  devPlaintext.set(nonce, code);
}

export function __peekOtpForTests(nonce: string): string | undefined {
  if (process.env.NODE_ENV === "production") return undefined;
  return devPlaintext.get(nonce);
}
