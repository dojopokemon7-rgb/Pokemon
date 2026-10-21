/**
 * Per-page admin backstop for admin ROUTE-GROUP server components.
 *
 * The (admin)/admin layout is the primary gate — it reads the signed
 * `dojo_admin_session` cookie and renders the login/OTP form in-place when it's
 * missing/invalid. But Next.js RSC segment caching / soft navigation can, in
 * principle, render a page segment WITHOUT re-running the layout guard, which
 * would let an admin page execute its Prisma reads of PII/financial data with
 * no auth check of its own (audit 10 F1, defense-in-depth).
 *
 * This helper is that per-page backstop: EVERY admin page server component calls
 * it at the TOP, BEFORE any data read. It uses the SAME verifier the layout uses
 * (`verifyAdminSession` over the `dojo_admin_session` cookie) — no new auth path.
 * On failure it redirects to `/admin`, where the layout renders AdminAuthGate
 * (the dedicated admin login, never the public /login — RULE 15).
 *
 * Server-only: pulls `cookies()` / `redirect()` from next. Keep it OUT of any
 * page.tsx (no new non-default page exports); pages import and call it.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_SESSION_COOKIE, verifyAdminSession } from "@/lib/utils/admin-session";

/**
 * Verifies the admin session cookie; `redirect("/admin")` (which throws) on any
 * missing/invalid/expired session so no PII read runs for an unauthenticated
 * caller. Returns `void` on success so callers can `await` it and continue.
 */
export async function requireAdminPage(): Promise<void> {
  const token = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
  if (!verifyAdminSession(token)) {
    // Same destination as the layout's in-place gate: /admin renders AdminAuthGate.
    redirect("/admin");
  }
}
