/**
 * POST /api/admin-auth/login — admin password step (step 1 of 2).
 *
 * The ONLY place admin credentials are checked. Flow:
 *   body {email,password} → constant-time verify against the ENV admin creds →
 *   on success mint a random login nonce, create an OTP challenge keyed by it,
 *   EMAIL the code to ADMIN_EMAIL via the existing sendOtpEmail, set a
 *   short-lived httpOnly nonce cookie, return {step:"otp"}.
 *
 * SECURITY:
 *  - rate-limited per IP (brute-force cap) via the existing fail-open limiter.
 *  - generic 401 on bad creds — never reveals which field failed nor whether
 *    the admin email exists.
 *  - the password/OTP are never logged (sendOtpEmail only dev-logs the code in
 *    non-prod, exactly like the user OTP path).
 *  - creds compared with constant-time hashed buffers (admin-credentials.ts).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyAdminCredentials } from "@/lib/utils/admin-credentials";
import { createOtpChallenge } from "@/lib/utils/admin-otp-store";
import {
  ADMIN_LOGIN_NONCE_COOKIE,
  ADMIN_LOGIN_NONCE_TTL_SECONDS,
  adminSessionCookieOptions,
} from "@/lib/utils/admin-session";
import { sendOtpEmail } from "@/lib/utils/ses-email";
import { enforceRateLimit, authTier, clientIp } from "@/lib/utils/rate-limit";
import { randomUUID } from "crypto";

const bodySchema = z.object({
  email: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(256),
});

export async function POST(request: Request): Promise<NextResponse> {
  const limited = await enforceRateLimit(request, authTier(), {
    kind: "ip",
    id: clientIp(request),
  });
  if (limited) return limited;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    // Shape errors collapse into the SAME generic 401 so a malformed body is
    // indistinguishable from wrong creds (no field-level leak).
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  if (!verifyAdminCredentials(parsed.data.email, parsed.data.password)) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  // Password OK → mint a nonce, generate + email a fresh OTP.
  const nonce = randomUUID();
  const code = createOtpChallenge(nonce);
  // ADMIN_EMAIL is guaranteed set here (verifyAdminCredentials returned true).
  await sendOtpEmail({ to: process.env.ADMIN_EMAIL!, code, type: "admin-login" });

  const res = NextResponse.json({ step: "otp" });
  res.cookies.set(
    ADMIN_LOGIN_NONCE_COOKIE,
    nonce,
    adminSessionCookieOptions(ADMIN_LOGIN_NONCE_TTL_SECONDS)
  );
  return res;
}
