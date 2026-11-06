/**
 * POST /api/admin-auth/verify-otp — admin OTP step (step 2 of 2).
 *
 * body {code} + the httpOnly `dojo_admin_login` nonce cookie → verify the OTP
 * against the challenge for that nonce → on success mint the 4h admin session
 * cookie (`dojo_admin_session`), clear the nonce cookie, return {ok:true}.
 *
 * SECURITY:
 *  - rate-limited per IP (same fail-open limiter as the password step).
 *  - durable, non-Redis, GLOBAL cap on OTP guesses across ALL nonces (max 10 per
 *    15 min, admin-login-guard.service.ts, M-2) so repeating the password step
 *    to get a fresh per-nonce budget cannot reset the guess budget. A full
 *    successful login resets the guard counters.
 *  - OTP is single-use, expires (10 min), and locks after 5 wrong attempts
 *    (store-enforced); on `locked` the nonce cookie is cleared and {relogin:true}
 *    forces the admin back to the password step.
 *  - the admin session cookie is httpOnly + SameSite=Strict + Secure(prod),
 *    HMAC-signed with a server-only secret.
 *  - the code is never logged.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyOtp } from "@/lib/utils/admin-otp-store";
import {
  ADMIN_LOGIN_NONCE_COOKIE,
  ADMIN_SESSION_COOKIE,
  adminSessionCookieOptions,
  signAdminSession,
} from "@/lib/utils/admin-session";
import {
  reserveAdminOtpAttempt,
  resetAdminGuard,
} from "@/lib/services/admin-login-guard.service";
import { enforceRateLimit, authTier, clientIp } from "@/lib/utils/rate-limit";

const bodySchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/),
});

/** Expires the login-nonce cookie on a response. */
function clearNonceCookie(res: NextResponse): void {
  res.cookies.set(ADMIN_LOGIN_NONCE_COOKIE, "", { ...adminSessionCookieOptions(0), maxAge: 0 });
}

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, authTier(), {
    kind: "ip",
    id: clientIp(request),
  });
  if (limited) return limited;

  // Read the nonce from the httpOnly login cookie.
  const nonce = readCookie(request.headers.get("cookie"), ADMIN_LOGIN_NONCE_COOKIE);
  if (!nonce) {
    return NextResponse.json({ error: "Session expired", relogin: true }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid code" }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid code" }, { status: 401 });
  }

  // Reserve a guess in the cross-nonce durable budget BEFORE verifying; once the
  // window's budget is spent even the correct code is refused (no oracle).
  const guess = await reserveAdminOtpAttempt();
  if (!guess.allowed) {
    const res = NextResponse.json(
      { error: "Too many attempts. Try again later.", relogin: true },
      { status: 429, headers: { "Retry-After": "900" } }
    );
    clearNonceCookie(res);
    return res;
  }

  const result = verifyOtp(nonce, parsed.data.code);
  if (result.ok) {
    await resetAdminGuard(); // full password+OTP login done → clear counters
    const res = NextResponse.json({ ok: true });
    res.cookies.set(ADMIN_SESSION_COOKIE, signAdminSession(), adminSessionCookieOptions());
    clearNonceCookie(res);
    return res;
  }

  if (result.reason === "locked" || result.reason === "unknown") {
    // Too many attempts, or the challenge is gone → force password re-entry.
    const res = NextResponse.json({ error: "Too many attempts", relogin: true }, { status: 401 });
    clearNonceCookie(res);
    return res;
  }

  // expired | invalid → clear error, allow retry (with remaining count).
  return NextResponse.json(
    { error: result.reason === "expired" ? "Code expired" : "Invalid code", remaining: result.remaining },
    { status: 401 }
  );
}

/** Minimal Cookie-header parser (same idiom as auth-guard). */
function readCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}
