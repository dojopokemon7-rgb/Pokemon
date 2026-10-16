"use client";

/**
 * Admin Sidebar — fixed left rail, Dojo dark/gold styling, sharp edges (0px).
 *
 * Active link is detected via `usePathname()` and highlighted in gold.
 * Exact-match on the Overview link so `/admin/users` doesn't also
 * highlight `/admin`.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

interface NavItem {
  label: string;
  href: string;
  exact?: boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  { label: "Overview", href: "/admin", exact: true },
  { label: "Analytics", href: "/admin/analytics" },
  { label: "Users", href: "/admin/users" },
  { label: "Card Database", href: "/admin/cards" },
  { label: "Transactions", href: "/admin/transactions" },
  { label: "Audit Logs", href: "/admin/audit-logs" },
] as const;

export default function AdminSidebar() {
  const pathname = usePathname();
  const router = useRouter();

  async function handleLogout() {
    // Clear the admin session cookie server-side, then return to /admin so the
    // layout gate re-renders the login form (router.refresh re-reads the now-
    // absent session cookie on the server).
    try {
      await fetch("/api/admin-auth/logout", { method: "POST", credentials: "include" });
    } catch {
      // Non-fatal — even if the request fails the user is sent back to /admin.
    }
    router.push("/admin");
    router.refresh();
  }

  const isActive = (item: NavItem): boolean =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href);

  return (
    <aside
      className="fixed left-0 top-0 bottom-0 w-[240px] flex flex-col"
      style={{
        background: "var(--color-dojo-app)",
        borderRight: "1px solid var(--color-dojo-stroke)",
      }}
    >
      {/* --- Brand mark --- */}
      <div
        className="px-6 py-6"
        style={{ borderBottom: "1px solid var(--color-dojo-stroke)" }}
      >
        <div
          className="dojo-heading"
          style={{
            fontSize: "22px",
            letterSpacing: "0.08em",
            color: "var(--color-dojo-gold)",
          }}
        >
          DOJO
        </div>
        <div
          className="dojo-step-label"
          style={{ marginTop: "4px", fontSize: "9px" }}
        >
          Admin Panel
        </div>
      </div>

      {/* --- Primary nav --- */}
      <nav className="flex-1 py-4">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item);
          return (
            <Link
              key={item.href}
              href={item.href}
              className="block px-6 py-3"
              style={{
                fontFamily: "var(--font-display)",
                fontWeight: 700,
                fontSize: "11px",
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: active
                  ? "var(--color-dojo-gold)"
                  : "var(--color-dojo-body)",
                borderLeft: active
                  ? "2px solid var(--color-dojo-gold)"
                  : "2px solid transparent",
                background: active ? "rgba(233,180,59,0.06)" : "transparent",
                transition: "color 120ms ease, background 120ms ease",
              }}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* --- Log out --- (replaces the old "Back to App" link: the admin
          world is isolated from the user app, so there is no in-app link out —
          only an explicit admin logout that clears the admin session.) */}
      <div
        className="px-6 py-5"
        style={{ borderTop: "1px solid var(--color-dojo-stroke)" }}
      >
        <button
          type="button"
          onClick={handleLogout}
          className="dojo-link"
          style={{ fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase" }}
        >
          Log Out
        </button>
      </div>
    </aside>
  );
}
