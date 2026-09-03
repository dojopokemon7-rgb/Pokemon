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
import { prisma } from "@/lib/db";
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
  // bookmark, deep link, etc.). Non-admins fall through as normal.
  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { isAdmin: true },
  });
  if (dbUser?.isAdmin) {
    redirect("/admin");
  }

  return <DashboardClientShell>{children}</DashboardClientShell>;
}
