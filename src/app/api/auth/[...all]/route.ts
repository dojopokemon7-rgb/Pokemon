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

// Export named GET and POST handlers — required by Next.js App Router
export const { GET, POST } = toNextJsHandler(auth);
