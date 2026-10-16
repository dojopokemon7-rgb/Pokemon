/**
 * Admin Route Group Layout — (admin)/admin
 *
 * The admin world is an ISOLATED, Better-Auth-decoupled surface. This server
 * component is the real gate: it reads the signed `dojo_admin_session` cookie
 * and verifies its HMAC + expiry (`verifyAdminSession`). It does NOT consult
 * Better Auth sessions nor the Prisma `isAdmin` column (both retired as admin
 * auth sources).
 *
 *   - No valid admin session → render the dedicated admin LOGIN/OTP flow
 *     (AdminAuthGate) IN PLACE, never a redirect to the public /login.
 *   - Valid admin session → render the sidebar + panel.
 *
 * The admin session is established only at /admin via password + mandatory
 * email OTP (see /api/admin-auth/*). Edge middleware no longer guards /admin —
 * this layout owns the gate so the login form can render in-place.
 */

import { cookies } from "next/headers";
import { ADMIN_SESSION_COOKIE, verifyAdminSession } from "@/lib/utils/admin-session";
import AdminSidebar from "./_components/AdminSidebar";
import AdminAuthGate from "./_components/AdminAuthGate";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_SESSION_COOKIE)?.value;

  if (!verifyAdminSession(token)) {
    // No valid admin session — show the login/OTP form in-place, NOT the panel
    // and NOT a redirect to /login.
    return <AdminAuthGate />;
  }

  return (
    // `h-screen` + `overflow-y-auto` on <main>: globals.css locks
    // html/body to overflow:hidden, so admin pages taller than the
    // viewport (user tables, audit logs) need their own scroll region.
    <div className="h-screen overflow-hidden bg-[var(--color-dojo-app)] text-[var(--color-dojo-ink)] flex">
      <AdminSidebar />
      <main className="dojo-scroll-hidden flex-1 ml-[240px] h-screen overflow-y-auto">{children}</main>
    </div>
  );
}
