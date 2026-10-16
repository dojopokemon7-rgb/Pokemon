/**
 * Admin session token — HMAC-signed, self-contained, server-only.
 *
 * The admin session is its OWN mechanism, fully DECOUPLED from Better Auth: a
 * single signed httpOnly cookie carries a short-lived JSON payload `{iat,exp,v}`
 * and an HMAC-SHA256 signature over that payload. No DB table, no new
 * dependency (Node `crypto` only) — correct for the single env-defined admin.
 *
 * Token wire format:  base64url(JSON payload) + "." + base64url(HMAC-SHA256)
 *
 * SECURITY:
 *  - signed with ADMIN_SESSION_SECRET (falls back to BETTER_AUTH_SECRET); if
 *    NEITHER is set we THROW rather than sign with an empty key (fail-closed).
 *  - the signature is verified with `crypto.timingSafeEqual` over equal-length
 *    buffers (recomputed vs presented) so a forged signature can't be found by
 *    timing; any tamper to the payload changes the HMAC and is rejected.
 *  - `exp` is enforced on EVERY verify — an expired token is rejected even if
 *    its signature is valid.
 *  - cookie is httpOnly + SameSite=Strict + Secure in production + Path=/.
 */

import { createHmac, timingSafeEqual } from "crypto";

export const ADMIN_SESSION_COOKIE = "dojo_admin_session" as const;
export const ADMIN_LOGIN_NONCE_COOKIE = "dojo_admin_login" as const;

/** 4-hour admin session — balances a usable session against PII blast radius. */
export const ADMIN_SESSION_TTL_SECONDS = 4 * 60 * 60;
/** 10-minute window to complete the OTP step after the password passes. */
export const ADMIN_LOGIN_NONCE_TTL_SECONDS = 10 * 60;

interface AdminSessionPayload {
  iat: number; // issued-at, epoch seconds
  exp: number; // expiry, epoch seconds
  v: 1; // schema version
}

/** Returns the signing secret, THROWING if neither env secret is set. */
function signingSecret(): string {
  const secret = process.env.ADMIN_SESSION_SECRET ?? process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "Admin session secret missing: set ADMIN_SESSION_SECRET (or BETTER_AUTH_SECRET)."
    );
  }
  return secret;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function hmac(payloadB64: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payloadB64).digest();
}

/**
 * Mints a signed admin-session token valid for `ttlSeconds` (default 4h).
 * Throws if no signing secret is configured.
 */
export function signAdminSession(ttlSeconds: number = ADMIN_SESSION_TTL_SECONDS): string {
  const secret = signingSecret();
  const now = Math.floor(Date.now() / 1000);
  const payload: AdminSessionPayload = { iat: now, exp: now + ttlSeconds, v: 1 };
  const payloadB64 = b64url(JSON.stringify(payload));
  const sigB64 = b64url(hmac(payloadB64, secret));
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verifies a token: well-formed, signature matches (constant-time), not expired.
 * Returns false on ANY problem (missing/empty, malformed, bad signature,
 * expired, no secret) — never throws to the caller.
 */
export function verifyAdminSession(token: string | undefined | null): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return false;

  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  let secret: string;
  try {
    secret = signingSecret();
  } catch {
    return false; // no secret → cannot verify → reject (fail-closed)
  }

  const expected = hmac(payloadB64, secret);
  let presented: Buffer;
  try {
    presented = Buffer.from(sigB64, "base64url");
  } catch {
    return false;
  }
  // Equal-length guard BEFORE timingSafeEqual (it throws on mismatch); a wrong
  // length is already a reject, so this leaks nothing a size check wouldn't.
  if (presented.length !== expected.length) return false;
  if (!timingSafeEqual(presented, expected)) return false;

  // Signature authentic → the payload is trustworthy; now enforce expiry.
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as
      | Partial<AdminSessionPayload>
      | null;
    if (!payload || typeof payload.exp !== "number") return false;
    return Math.floor(Date.now() / 1000) < payload.exp;
  } catch {
    return false;
  }
}

/**
 * Cookie options for the admin session cookie. `secure` only in production so
 * local http dev still works; SameSite=Strict so the cookie never rides a
 * cross-site request.
 */
export function adminSessionCookieOptions(maxAge: number = ADMIN_SESSION_TTL_SECONDS) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
    maxAge,
  };
}
