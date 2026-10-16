/**
 * POST /api/admin-auth/logout — clears the admin session.
 *
 * Expires both the admin session cookie and any lingering login-nonce cookie,
 * so the next /admin visit renders the login form. Called by the sidebar
 * LOG OUT control.
 */

import { NextResponse } from "next/server";
import {
  ADMIN_LOGIN_NONCE_COOKIE,
  ADMIN_SESSION_COOKIE,
  adminSessionCookieOptions,
} from "@/lib/utils/admin-session";

export async function POST(): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_SESSION_COOKIE, "", { ...adminSessionCookieOptions(0), maxAge: 0 });
  res.cookies.set(ADMIN_LOGIN_NONCE_COOKIE, "", { ...adminSessionCookieOptions(0), maxAge: 0 });
  return res;
}
