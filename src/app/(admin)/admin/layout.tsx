/**
 * Admin Route Group Layout — (admin)/admin
 *
 * Two-tier enforcement:
 *   1. Middleware (edge) — checks the session cookie exists and redirects
 *      unauthenticated users to /login. Cannot verify isAdmin because the
 *      Edge runtime cannot reach Prisma.
 *   2. This layout (server component) — the real gate. Re-reads
 *      `isAdmin` from the database on every request and redirects
 *      non-admins to /dashboard (fail-closed — doesn't leak /admin URLs).
 *
 * Never trust the session cookie for admin authorization: it is client-side
 * mutable and admin status can be revoked at any moment.
 */

import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/utils/get-server-session";
import { prisma } from "@/lib/db";
import AdminSidebar from "./_components/AdminSidebar";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();
  if (!session) redirect("/login");

  // Admin status is re-read FRESH from the DB on every admin request, NOT
  // trusted from the 5-minute cookie-cached session claim. The admin surface
  // exposes every user's PII (emails, portfolio values), so a revoked admin
  // must lose access IMMEDIATELY, not up to 5 minutes later. One indexed
  // findUnique per admin page load is a negligible cost for that guarantee.
  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { isAdmin: true },
  });
  if (!dbUser?.isAdmin) {
    redirect("/dashboard");
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
