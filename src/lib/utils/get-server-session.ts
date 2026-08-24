/**
 * Server-Side Session Helper
 *
 * Use this in Next.js 15 Server Components and Server Actions to retrieve
 * the currently authenticated user's session.
 *
 * @module get-server-session
 *
 * -------------------------------------------------------------------
 * USAGE IN SERVER COMPONENTS
 * -------------------------------------------------------------------
 * ```ts
 * import { getServerSession } from "@/lib/utils/get-server-session";
 *
 * export default async function ProfilePage() {
 *   const session = await getServerSession();
 *   if (!session) redirect("/login");
 *   return <div>Hello, {session.user.name}</div>;
 * }
 * ```
 *
 * -------------------------------------------------------------------
 * USAGE IN SERVER ACTIONS
 * -------------------------------------------------------------------
 * ```ts
 * "use server";
 * import { getServerSession } from "@/lib/utils/get-server-session";
 *
 * export async function updateProfile(data: FormData) {
 *   const session = await getServerSession();
 *   if (!session) throw new Error("Unauthorized");
 *   // ... perform action
 * }
 * ```
 *
 * -------------------------------------------------------------------
 * NOTE: Do NOT use this in API Route handlers (route.ts).
 * For API routes, use `requireAuth` from `@/lib/utils/auth-guard` instead,
 * which reads headers from the incoming `Request` object.
 * -------------------------------------------------------------------
 */

import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

/**
 * The shape of a resolved session returned by Better Auth.
 * This is derived directly from the `auth` instance for type safety.
 */
export type ServerSession = typeof auth.$Infer.Session;

/**
 * Retrieves the current server-side session by reading the request
 * headers from Next.js 15's `headers()` API.
 *
 * Next.js 15 changed `headers()` to return a `Promise<ReadonlyHeaders>`,
 * so we must `await` it before passing it to Better Auth's session resolver.
 *
 * @returns The session object `{ session, user }` if authenticated,
 *          or `null` if no valid session exists.
 */
export async function getServerSession(): Promise<ServerSession | null> {
  // In Next.js 15, `headers()` is async and returns a Promise.
  // We must await it to get the actual ReadonlyHeaders object.
  const headersList = await headers();

  const session = await auth.api.getSession({
    headers: headersList,
  });

  // Better Auth returns `null` for missing/expired sessions.
  return session ?? null;
}

/**
 * A stricter variant that throws a redirect-compatible error if no session
 * is found. Designed for use in layouts that guard entire route groups.
 *
 * Requires `import { redirect } from "next/navigation"` in the calling file.
 *
 * @example
 * ```ts
 * import { redirect } from "next/navigation";
 * import { getServerSessionOrRedirect } from "@/lib/utils/get-server-session";
 *
 * export default async function DashboardLayout({ children }) {
 *   const session = await getServerSessionOrRedirect("/login");
 *   return <>{children}</>;
 * }
 * ```
 */
export async function getServerSessionOrRedirect(
  redirectTo: string = "/login"
): Promise<ServerSession> {
  const session = await getServerSession();

  if (!session) {
    // `redirect()` from next/navigation is typed as `never` — it throws
    // a NEXT_REDIRECT internal error that Next.js catches and handles.
    // The static import (vs dynamic) is required for TypeScript to infer
    // the `never` return type and correctly narrow `session` below.
    redirect(redirectTo);
  }

  // TypeScript now knows session is non-null: redirect() is `never`,
  // so this line is only reached when session exists.
  return session;
}
