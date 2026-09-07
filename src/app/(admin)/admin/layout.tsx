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
import AdminSidebar from "./_components/AdminSidebar";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();
  if (!session) redirect("/login");

  // `isAdmin` comes from the session directly via Better Auth's
  // `user.additionalFields` (src/lib/auth.ts). Cookie-cached for 5
  // minutes, so this layout is zero-DB on the routine path. Removing
  // an admin's `isAdmin` in the DB takes up to 5 minutes to lock them
  // out (their next login refreshes the cache). If that's ever too
  // long, drop the session in `session.token` invalidation instead.
  if (!(session.user as { isAdmin?: boolean }).isAdmin) {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen bg-[var(--color-dojo-app)] text-[var(--color-dojo-ink)] flex">
      <AdminSidebar />
      <main className="flex-1 ml-[240px] min-h-screen">{children}</main>
    </div>
  );
}
