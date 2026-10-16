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

  // The admin panel is now an isolated surface (env creds + OTP at /admin),
  // fully decoupled from Better Auth. `isAdmin` is retired as an auth source,
  // so a normal user is NEVER bounced out of the dashboard here.

  return <DashboardClientShell>{children}</DashboardClientShell>;
}
