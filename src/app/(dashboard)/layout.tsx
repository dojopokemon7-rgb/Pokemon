/**
 * Dashboard Route Group Layout — (dashboard)
 *
 * Enforces server-side authentication.
 *   - If !session → redirect to /login
 *
 * Phone verification removed for MVP — re-enable in Week 4.
 *
 * Renders the interactive DashboardClientShell with top header and bottom nav.
 */

import { getServerSession } from "@/lib/utils/get-server-session";
import { redirect } from "next/navigation";
import DashboardClientShell from "./dashboard-client-shell";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();

  if (!session) {
    redirect("/login");
  }

  // Admins live in the admin panel — bounce them there whenever they
  // land on any /dashboard-group route (login redirect, refresh,
  // bookmark, deep link, etc.). `isAdmin` is on the session directly
  // via Better Auth's `user.additionalFields` (see src/lib/auth.ts),
  // served from the cookie cache — no extra DB round-trip.
  if ((session.user as { isAdmin?: boolean }).isAdmin) {
    redirect("/admin");
  }

  return <DashboardClientShell>{children}</DashboardClientShell>;
}
