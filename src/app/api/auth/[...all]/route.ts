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
import { enforceRateLimit, authTier, clientIp } from "@/lib/utils/rate-limit";

const handlers = toNextJsHandler(auth);

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
  if (pathname.startsWith("/api/auth/sign-in") || pathname.startsWith("/api/auth/sign-up")) {
    const limited = await enforceRateLimit(request, authTier(), {
      kind: "ip",
      id: clientIp(request),
    });
    if (limited) return limited;
  }
  return handlers.POST(request);
}
