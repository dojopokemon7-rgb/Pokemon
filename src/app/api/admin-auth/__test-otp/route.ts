/**
 * GET /api/admin-auth/__test-otp — DEV/TEST ONLY admin OTP read seam.
 *
 * The admin OTP is held in an in-memory Map (admin-otp-store.ts), NOT the DB,
 * so the Playwright `read-otp.ts` DB fixture can't see it. This route lets the
 * e2e suite retrieve the current code for the nonce in the `dojo_admin_login`
 * cookie against the RUNNING server process.
 *
 * HARD-DISABLED IN PRODUCTION: returns 404 when NODE_ENV === "production", and
 * `__peekOtpForTests` itself also no-ops in prod — defense in depth so the
 * plaintext code can never be read on a real deployment.
 */

import { NextResponse } from "next/server";
import { __peekOtpForTests } from "@/lib/utils/admin-otp-store";
import { ADMIN_LOGIN_NONCE_COOKIE } from "@/lib/utils/admin-session";

export async function GET(request: Request): Promise<NextResponse> {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const cookieHeader = request.headers.get("cookie");
  const nonce = readCookie(cookieHeader, ADMIN_LOGIN_NONCE_COOKIE);
  if (!nonce) return NextResponse.json({ error: "No pending login" }, { status: 404 });

  const code = __peekOtpForTests(nonce);
  if (!code) return NextResponse.json({ error: "No code" }, { status: 404 });
  return NextResponse.json({ code });
}

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
