/**
 * GET /api/users/me
 *
 * Returns the full profile of the currently authenticated user.
 * This route is protected — a valid Better Auth session is required.
 *
 * -------------------------------------------------------------------
 * TEST WITH cURL:
 * -------------------------------------------------------------------
 * First sign in to get a session cookie:
 *   curl -c cookies.txt -X POST http://localhost:3000/api/auth/sign-in/email \
 *     -H "Content-Type: application/json" \
 *     -d '{"email":"user@example.com","password":"yourpassword"}'
 *
 * Then call this endpoint with the session cookie:
 *   curl -b cookies.txt http://localhost:3000/api/users/me
 *
 * -------------------------------------------------------------------
 * TEST WITH POSTMAN:
 * -------------------------------------------------------------------
 * 1. POST to /api/auth/sign-in/email with JSON body to get a cookie.
 * 2. Postman automatically stores cookies — just call GET /api/users/me.
 * -------------------------------------------------------------------
 */

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/utils/auth-guard";
import { prisma } from "@/lib/db";

/**
 * The shape of the public user profile returned by this endpoint.
 * Sensitive or internal fields (e.g., raw session tokens) are excluded.
 */
interface PublicUserProfile {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  phoneNumber: string | null;
  phoneNumberVerified: boolean | null;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function GET(request: Request): Promise<NextResponse> {
  // ----------------------------------------------------------------
  // 1. Authenticate — reject if no valid session
  // ----------------------------------------------------------------
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;

  const { session } = guard;

  // ----------------------------------------------------------------
  // 2. Fetch full user record from database
  // ----------------------------------------------------------------
  // Better Auth's session already contains a user object, but we fetch
  // from the database to ensure we have the latest data (the session
  // cache may be up to 5 minutes stale per cookieCache.maxAge config).
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      phoneNumber: true,
      phoneNumberVerified: true,
      image: true,
      createdAt: true,
      updatedAt: true,
      // Deliberately NOT selecting: accounts (has hashed passwords),
      // sessions (security tokens), or collections (separate endpoint).
    },
  });

  // ----------------------------------------------------------------
  // 3. Guard against deleted/desynced users
  // ----------------------------------------------------------------
  if (!user) {
    return NextResponse.json(
      {
        error: "Not Found",
        message: "Authenticated user record not found in database.",
      },
      { status: 404 }
    );
  }

  // ----------------------------------------------------------------
  // 4. Return the public profile
  // ----------------------------------------------------------------
  const profile: PublicUserProfile = user;

  return NextResponse.json(
    { data: profile },
    {
      status: 200,
      headers: {
        // Prevent proxies/CDNs from caching personal user data
        "Cache-Control": "no-store",
      },
    }
  );
}

/**
 * PATCH /api/users/me
 *
 * Stub for updating the authenticated user's profile.
 * Implement in Week 2 when the profile edit UI is ready.
 */
export async function PATCH(request: Request): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;

  // TODO (Week 2): Parse and validate request body with Zod,
  // then call prisma.user.update({ where: { id: session.user.id }, data: ... })
  return NextResponse.json(
    { message: "Profile update endpoint — coming in Week 2." },
    { status: 501 }
  );
}
