/**
 * Better Auth — Catch-all API Route Handler
 *
 * This route catches all requests to `/api/auth/*` and delegates them
 * to the Better Auth instance. Better Auth handles:
 *   - POST /api/auth/sign-in/email
 *   - POST /api/auth/sign-up/email
 *   - POST /api/auth/sign-out
 *   - POST /api/auth/phone-number/send-otp
 *   - POST /api/auth/phone-number/verify-otp
 *   - GET  /api/auth/session
 *   - GET  /api/auth/callback/[provider]  (OAuth — Week 4+)
 *   - ...and more
 *
 * The `toNextJsHandler` helper converts the Better Auth handler
 * into Next.js App Router GET/POST handler functions.
 */

import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { NextResponse } from "next/server";
import { z } from "zod";
import { enforceRateLimit, authTier, clientIp } from "@/lib/utils/rate-limit";

const handlers = toNextJsHandler(auth);

// ---------------------------------------------------------------------------
// H-1 — Server-side password policy (OWASP A07/A04)
// ---------------------------------------------------------------------------
// The signup PAGE validates "8+ chars, 1+ number" client-side, but that check
// is trivially bypassed by POSTing straight to /api/auth/sign-up/email. The
// Better Auth core only enforces `minPasswordLength`, so we gate the password
// HERE — on the server — before the request reaches the sign-up handler.
//
// Policy: 8–128 chars, at least one number, one lowercase, one uppercase.
// (128 stays within bcrypt's 72-byte ceiling as configured in lib/auth.ts.)
const passwordPolicy = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .max(128, "Password must be at most 128 characters.")
  .regex(/\d/, "Password must contain at least one number.")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter.")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter.");

/**
 * Validates the password on a /sign-up/email POST. Returns a 400 `Response`
 * when the policy is violated, otherwise `null` (let the request proceed).
 *
 * The request body stream can only be read once, so the CALLER must pass a
 * clone — the untouched original is what reaches Better Auth's handler.
 * Fail-open on a malformed/unreadable body: we don't own sign-up's own
 * validation (missing fields, bad email, etc.), so we defer those 400s to
 * Better Auth rather than second-guessing the payload shape here.
 */
async function validateSignUpPassword(clone: Request): Promise<Response | null> {
  let body: unknown;
  try {
    body = await clone.json();
  } catch {
    return null; // not JSON / empty — let Better Auth reject it.
  }

  const password = (body as { password?: unknown })?.password;
  if (typeof password !== "string") return null; // let Better Auth handle it.

  const result = passwordPolicy.safeParse(password);
  if (result.success) return null;

  return NextResponse.json(
    {
      // Mirror Better Auth's error shape so the signup page's
      // `authError.message` rendering surfaces this unchanged.
      code: "PASSWORD_POLICY_VIOLATION",
      message: result.error.issues[0]?.message ?? "Password does not meet the requirements.",
    },
    { status: 400 }
  );
}

// GET is exported UNWRAPPED: `get-session` is a GET fired on EVERY page load,
// so it must NEVER be rate-limited — doing so would break normal navigation.
export const GET = handlers.GET;

/**
 * POST wrapper — rate-limits ONLY the credential endpoints by client IP.
 *
 * Better Auth multiplexes many POST paths through this catch-all (sign-in,
 * sign-up, sign-out, OAuth callbacks, …). We cap ONLY the brute-forceable
 * credential POSTs (`/api/auth/sign-in*`, `/api/auth/sign-up*`) and let every
 * other POST (sign-out, callbacks, etc.) pass straight through, so the E2E auth
 * setup (a single sign-in) and the OAuth flows are untouched. Fail-open: a
 * Redis outage disables the cap, never blocks the login.
 */
export async function POST(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (
    pathname.startsWith("/api/auth/sign-in") ||
    pathname.startsWith("/api/auth/sign-up") ||
    // Email-OTP verification: send-verification-otp + verify-email. The plugin
    // also registers its own 3/60s per-path cap, but that is in-memory /
    // per-instance; this shared Redis authTier IP cap is the cross-instance net
    // and also covers dev (where the plugin cap is off). See design.md §5.
    pathname.startsWith("/api/auth/email-otp")
  ) {
    const limited = await enforceRateLimit(request, authTier(), {
      kind: "ip",
      id: clientIp(request),
    });
    if (limited) return limited;
  }

  // H-1: enforce the password policy on sign-up BEFORE Better Auth sees it.
  // Clone so the body stream stays unconsumed for the real handler below.
  if (pathname.startsWith("/api/auth/sign-up/email")) {
    const rejected = await validateSignUpPassword(request.clone());
    if (rejected) return rejected;
  }

  return handlers.POST(request);
}
