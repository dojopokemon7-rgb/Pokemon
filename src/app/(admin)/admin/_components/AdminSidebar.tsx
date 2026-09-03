"use client";

/**
 * Admin Sidebar — fixed left rail, Dojo dark/gold styling, sharp edges (0px).
 *
 * Active link is detected via `usePathname()` and highlighted in gold.
 * Exact-match on the Overview link so `/admin/users` doesn't also
 * highlight `/admin`.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  label: string;
  href: string;
  exact?: boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  { label: "Overview", href: "/admin", exact: true },
  { label: "Users", href: "/admin/users" },
  { label: "Card Database", href: "/admin/cards" },
  { label: "Transactions", href: "/admin/transactions" },
  { label: "Audit Logs", href: "/admin/audit-logs" },
] as const;

export default function AdminSidebar() {
  const pathname = usePathname();

  const isActive = (item: NavItem): boolean =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href);

  return (
    <aside
      className="fixed left-0 top-0 bottom-0 w-[240px] flex flex-col"
      style={{
        background: "#0D0D0D",
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

      {/* --- Back to app --- */}
      <div
        className="px-6 py-5"
        style={{ borderTop: "1px solid var(--color-dojo-stroke)" }}
      >
        <Link
          href="/dashboard"
          className="dojo-link"
          style={{ fontSize: "10px" }}
        >
          ← Back to App
        </Link>
      </div>
    </aside>
  );
}
