/**
 * Admin credential compare — constant-time, server-only.
 *
 * The single admin is defined in the ENVIRONMENT (ADMIN_EMAIL / ADMIN_PASSWORD),
 * NOT the database (`isAdmin` is retired as an auth source). These values are
 * read server-side only and MUST NEVER reach the client bundle — this module is
 * imported solely from API routes / server actions / server components.
 *
 * SECURITY: the password (and email) are compared with `crypto.timingSafeEqual`
 * over fixed-length SHA-256 digests of both sides — NEVER a plain `===`, which
 * leaks a match/mismatch via an early-exit timing side channel. Hashing first
 * guarantees both buffers are exactly 32 bytes so `timingSafeEqual` (which
 * throws on unequal lengths) is always safe to call and never itself leaks the
 * input length. Inputs are never logged.
 */

import { createHash, timingSafeEqual } from "crypto";

/**
 * Constant-time string equality. SHA-256-digests both inputs to 32-byte buffers
 * then compares with `timingSafeEqual`. Equal-length buffers (always 32 bytes)
 * mean the compare time does not depend on where the first differing byte is,
 * nor on the input lengths.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  // Both are 32 bytes, so timingSafeEqual never throws on a length mismatch.
  return timingSafeEqual(da, db);
}

/**
 * Verifies a submitted email+password against the env-defined admin creds.
 *
 * Returns false (never throws, never reveals WHICH half failed) when either
 * `ADMIN_EMAIL` or `ADMIN_PASSWORD` is unset — a misconfigured deployment can
 * never accidentally authenticate. Email is matched case-insensitively (both
 * sides lowercased) via the same constant-time path; password is matched
 * exactly. BOTH compares are evaluated before the result is combined (they run
 * on their own lines above the `return`), so the work — and timing — does not
 * depend on whether the email matched.
 */
export function verifyAdminCredentials(email: string, password: string): boolean {
  const envEmail = process.env.ADMIN_EMAIL;
  const envPassword = process.env.ADMIN_PASSWORD;
  if (!envEmail || !envPassword) return false;

  const emailOk = constantTimeEqual(email.trim().toLowerCase(), envEmail.trim().toLowerCase());
  const passwordOk = constantTimeEqual(password, envPassword);
  return emailOk && passwordOk;
}
