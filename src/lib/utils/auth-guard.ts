/**
 * API Route Authentication Guard
 *
 * Use this in Next.js App Router `route.ts` files to protect API endpoints.
 * It reads the session from the incoming HTTP `Request` headers.
 *
 * @module auth-guard
 *
 * -------------------------------------------------------------------
 * USAGE PATTERN (Happy Path)
 * -------------------------------------------------------------------
 * ```ts
 * // src/app/api/some-protected/route.ts
 * import { requireAuth, type AuthGuardResult } from "@/lib/utils/auth-guard";
 * import { NextResponse } from "next/server";
 *
 * export async function GET(request: Request) {
 *   const guard = await requireAuth(request);
 *   if (guard.unauthorized) return guard.unauthorized;
 *
 *   // guard.session is guaranteed to be non-null here
 *   const { user } = guard.session;
 *   return NextResponse.json({ userId: user.id });
 * }
 * ```
 *
 * -------------------------------------------------------------------
 * WHY NOT USE getServerSession() IN API ROUTES?
 * -------------------------------------------------------------------
 * `getServerSession()` calls Next.js `headers()` which reads from the
 * current request context stored internally by Next.js. In API Route
 * handlers, this works too — but `requireAuth(request)` is more explicit,
 * testable, and passes the request object directly to Better Auth,
 * which is the recommended pattern for API routes.
 * -------------------------------------------------------------------
 */

import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import { ADMIN_SESSION_COOKIE, verifyAdminSession } from "@/lib/utils/admin-session";

/**
 * The shape of a validated session returned by Better Auth.
 */
export type AuthSession = typeof auth.$Infer.Session;

/**
 * Result type returned by `requireAuth`.
 *
 * - If the request is unauthenticated: `{ unauthorized: NextResponse, session: null }`
 * - If authenticated: `{ unauthorized: null, session: AuthSession }`
 *
 * This discriminated union pattern avoids throwing exceptions and lets
 * the route handler return cleanly with `if (guard.unauthorized) return guard.unauthorized`.
 */
export type AuthGuardResult =
  | { unauthorized: NextResponse; session: null }
  | { unauthorized: null; session: AuthSession };

/**
 * Validates the session from an incoming API request.
 *
 * Reads the `Cookie` and `Authorization` headers from the request and
 * validates the session token against the database via Better Auth.
 *
 * @param request - The incoming `Request` object from the route handler.
 * @returns An `AuthGuardResult` discriminated union.
 *
 * @example
 * ```ts
 * export async function POST(request: Request) {
 *   const guard = await requireAuth(request);
 *   if (guard.unauthorized) return guard.unauthorized;
 *
 *   const { session } = guard;
 *   // session.user.id, session.user.email, etc. are all available
 * }
 * ```
 */
export async function requireAuth(request: Request): Promise<AuthGuardResult> {
  const session = await auth.api.getSession({
    headers: request.headers,
  });

  if (!session) {
    return {
      unauthorized: NextResponse.json(
        {
          error: "Unauthorized",
          message: "A valid session is required to access this endpoint.",
        },
        { status: 401 }
      ),
      session: null,
    };
  }

  // Phone number verification removed for MVP — re-enable in Week 4
  // when SMS provider is configured.

  return {
    unauthorized: null,
    session,
  };
}

/**
 * Admin-only auth guard for API routes.
 *
 * The admin is now the ENV-defined superuser (ADMIN_EMAIL/ADMIN_PASSWORD),
 * authenticated via the isolated, Better-Auth-decoupled admin session set at
 * /admin after password + mandatory email OTP. This guard reads the signed
 * `dojo_admin_session` cookie from the request headers and verifies its HMAC +
 * expiry on EVERY call (`verifyAdminSession`). It does NOT touch Better Auth
 * nor the Prisma `isAdmin` column — `isAdmin` is retired as an auth source.
 *
 * Returns a `401` when there is no valid admin session, otherwise a success
 * result whose `session.user` carries the env admin identity (id "env-admin",
 * email ADMIN_EMAIL) so existing consumers (e.g. the card-edit audit log) keep
 * their `guard.session.user.id` / `.email` shape unchanged.
 *
 * @example
 * ```ts
 * export async function PATCH(request: Request) {
 *   const guard = await requireAdmin(request);
 *   if (guard.unauthorized) return guard.unauthorized;
 *   // guard.session.user is the confirmed env admin
 * }
 * ```
 */
export async function requireAdmin(request: Request): Promise<AuthGuardResult> {
  const token = readAdminSessionCookie(request.headers.get("cookie"));
  if (!verifyAdminSession(token)) {
    return {
      unauthorized: NextResponse.json(
        {
          error: "Unauthorized",
          message: "A valid admin session is required to access this endpoint.",
        },
        { status: 401 }
      ),
      session: null,
    };
  }

  // Minimal synthetic session so downstream consumers (audit log) keep their
  // `guard.session.user.{id,email}` contract. Cast to AuthSession: only the
  // user id/email are read by admin routes, and the admin identity is the
  // env superuser, not a DB user row.
  const adminEmail = process.env.ADMIN_EMAIL ?? "admin";
  return {
    unauthorized: null,
    session: {
      user: { id: "env-admin", email: adminEmail },
    } as unknown as AuthSession,
  };
}

/**
 * Pulls the `dojo_admin_session` cookie value out of a raw Cookie header.
 * Returns undefined when the header or the cookie is absent. Kept tiny and
 * dependency-free (middleware/Edge-safe shape, though only used in Node here).
 */
function readAdminSessionCookie(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === ADMIN_SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}
