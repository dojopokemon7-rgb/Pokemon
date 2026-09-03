/**
 * Next.js 15 Middleware — Route Protection
 *
 * Runs on the Edge runtime (before any rendering or API handler).
 * Protects the `(dashboard)` route group by checking for a valid
 * Better Auth session cookie.
 *
 * -------------------------------------------------------------------
 * ARCHITECTURE DECISION — Cookie-Check vs. Full API Validation
 * -------------------------------------------------------------------
 * Next.js middleware runs on the Edge runtime, which does NOT support
 * Node.js APIs (Prisma, ioredis, etc.). Therefore, we cannot call
 * `auth.api.getSession()` (which uses Prisma) directly here.
 *
 * Strategy:
 *   1. MIDDLEWARE: Checks for the presence of the session cookie.
 *      Fast (Edge-compatible), used for redirect UX.
 *   2. SERVER COMPONENTS / API ROUTES: Full DB-backed session validation
 *      via `getServerSession()` or `requireAuth()`.
 *
 * This is a defense-in-depth approach:
 *   - Middleware provides the UX redirect (users land on /login)
 *   - The actual data/API endpoints re-validate the session server-side
 *
 * -------------------------------------------------------------------
 * PROTECTED ROUTES
 * -------------------------------------------------------------------
 * Any path matching `/dashboard/*` is protected.
 * Auth pages (/login, /signup) redirect authenticated users to /dashboard.
 *
 * -------------------------------------------------------------------
 * FUTURE UPGRADE (Phase 3+ — Full Edge Session Validation)
 * -------------------------------------------------------------------
 * When JWT-based sessions are enabled (Better Auth `jwt` plugin), you can
 * verify the session token in middleware without a DB call:
 *
 *   import { verifyJWT } from "better-auth/crypto";
 *   const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
 *   const payload = await verifyJWT(token, process.env.BETTER_AUTH_SECRET!);
 *   if (!payload) return redirectToLogin(request);
 * -------------------------------------------------------------------
 */

import { type NextRequest, NextResponse } from "next/server";

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------

/**
 * The name of the session cookie set by Better Auth.
 *
 * Better Auth prefixes cookie names with `better-auth.` by default.
 * In production (HTTPS), it additionally prefixes with `__Secure-`.
 * We check for both to handle local dev (HTTP) and production (HTTPS).
 *
 * If you customise `advanced.cookiePrefix` in auth.ts, update this.
 */
const SESSION_COOKIE_NAME = "better-auth.session_token" as const;
const SECURE_SESSION_COOKIE_NAME = "__Secure-better-auth.session_token" as const;

/** Path to redirect unauthenticated users to. */
const LOGIN_PATH = "/login" as const;

/** Path to redirect already-authenticated users away from auth pages. */
const DEFAULT_AUTHENTICATED_PATH = "/dashboard" as const;

// ----------------------------------------------------------------
// Route Matchers
// ----------------------------------------------------------------

/**
 * Routes that require the user to be authenticated.
 * Any path segment that starts with these prefixes is protected.
 */
const PROTECTED_PREFIXES: readonly string[] = ["/dashboard", "/admin"];

/**
 * Routes that should only be accessible when NOT authenticated.
 * Authenticated users visiting these are redirected to the dashboard.
 */
const AUTH_ONLY_PATHS: readonly string[] = ["/login", "/signup", "/forgot-password"];

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

/**
 * Checks whether the incoming request has a Better Auth session cookie.
 * We check for both the standard and the `__Secure-` prefixed variant.
 */
function hasSessionCookie(request: NextRequest): boolean {
  return (
    request.cookies.has(SESSION_COOKIE_NAME) ||
    request.cookies.has(SECURE_SESSION_COOKIE_NAME)
  );
}

/**
 * Builds a redirect `NextResponse` preserving the original URL as a
 * `callbackUrl` query param, so the login page can redirect back after auth.
 */
function redirectToLogin(request: NextRequest): NextResponse {
  const loginUrl = new URL(LOGIN_PATH, request.url);
  // Encode the current path so we can redirect back after login
  loginUrl.searchParams.set("callbackUrl", request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

/**
 * Builds a redirect `NextResponse` to the dashboard (or a `callbackUrl`
 * if the user was trying to reach a protected page before they were authed).
 */
function redirectToDashboard(request: NextRequest): NextResponse {
  const callbackUrl = request.nextUrl.searchParams.get("callbackUrl");
  const destination = callbackUrl ?? DEFAULT_AUTHENTICATED_PATH;
  return NextResponse.redirect(new URL(destination, request.url));
}

// ----------------------------------------------------------------
// Middleware Function
// ----------------------------------------------------------------

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const isAuthenticated = hasSessionCookie(request);

  // ---- Guard: Protected routes → redirect to login if not authed ----
  const isProtected = PROTECTED_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix)
  );

  if (isProtected && !isAuthenticated) {
    return redirectToLogin(request);
  }

  // ---- All other routes: pass through unchanged ----
  return NextResponse.next();
}

// ----------------------------------------------------------------
// Middleware Matcher Configuration
// ----------------------------------------------------------------

/**
 * Tells Next.js which paths to run this middleware on.
 * We explicitly EXCLUDE:
 *   - `/_next/*`       — Next.js internals (static files, HMR)
 *   - `/api/auth/*`    — Better Auth's own endpoints (must be public)
 *   - `/api/health`    — Docker health check (must be public)
 *   - Static file extensions — images, fonts, favicons, etc.
 *
 * NOTE: The `(auth)` and `(dashboard)` route groups are folder-only
 * conventions in Next.js and do NOT appear in the URL. The actual
 * URL paths are `/login`, `/signup`, `/dashboard`, etc.
 */
export const config = {
  matcher: [
    /*
     * Match all request paths EXCEPT:
     * - _next/static (static files)
     * - _next/image  (image optimization files)
     * - favicon.ico, robots.txt, sitemap.xml
     * - /api/auth/* (Better Auth handler — always public)
     * - /api/health  (Docker health check — always public)
     * - Common static asset extensions
     */
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|api/auth|api/health|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|css|js)$).*)",
  ],
};
