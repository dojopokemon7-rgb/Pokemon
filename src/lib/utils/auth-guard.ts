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
 * Validates the session AND re-reads `isAdmin` from the database on
 * every call. Never trusts the session cookie for authorization —
 * admin status must be revocable in real time.
 *
 * Returns a `401` if unauthenticated, `403` if authenticated but not
 * an admin. Callers use the same discriminated-union pattern as
 * {@link requireAuth}.
 *
 * @example
 * ```ts
 * export async function PATCH(request: Request) {
 *   const guard = await requireAdmin(request);
 *   if (guard.unauthorized) return guard.unauthorized;
 *   // guard.session.user is a confirmed admin
 * }
 * ```
 */
export async function requireAdmin(request: Request): Promise<AuthGuardResult> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard;

  // Lazy import — keeps Prisma out of any edge-runtime paths that
  // don't touch this helper.
  const { prisma } = await import("@/lib/db");
  const dbUser = await prisma.user.findUnique({
    where: { id: guard.session.user.id },
    select: { isAdmin: true },
  });

  if (!dbUser?.isAdmin) {
    return {
      unauthorized: NextResponse.json(
        {
          error: "Forbidden",
          message: "Admin privileges required.",
        },
        { status: 403 }
      ),
      session: null,
    };
  }

  return guard;
}
