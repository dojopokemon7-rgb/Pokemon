"use client";

/**
 * Dashboard Client Shell — (dashboard)
 *
 * Provides:
 *   - Top header: DOJO wordmark + search + bell icons + log out button
 *   - Fixed bottom nav: Home · Portfolio · [Scan FAB] · Explore · You
 *   - Content area with safe padding above the bottom nav
 *
 * Nav item naming/routing/iconography is ported verbatim from the Dojo
 * prototype reference (dojo-prototype/app.js): `tabbar()` labels the
 * fourth tab "Explore", `TAB_ICONS.explore` is a magnifying-glass glyph
 * (not a people/users icon), and `A.tab`'s `explore -> 'search'` mapping
 * routes it to the search screen — there is no separate community/floor
 * screen in the reviewed flow (see .reference/dojo-design/README.md:
 * the peer-to-peer trading floor exists in the prototype code but is
 * intentionally unreachable from the tab bar).
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { useState } from "react";

// ── Icons (self-contained SVGs, no external dep) ──────────────────
function HomeIcon({ filled }: { filled?: boolean }) {
  return filled ? (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
    </svg>
  ) : (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <path d="M3 12L12 3l9 9" />
      <path d="M9 21V12h6v9" />
      <path d="M3 12v9h5v-6h8v6h5v-9" />
    </svg>
  );
}

function LayersIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}

function ScanIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <path d="M3 7V5a2 2 0 012-2h2" />
      <path d="M17 3h2a2 2 0 012 2v2" />
      <path d="M21 17v2a2 2 0 01-2 2h-2" />
      <path d="M7 21H5a2 2 0 01-2-2v-2" />
      <line x1="3" y1="12" x2="21" y2="12" />
    </svg>
  );
}

// Client feedback (Phase 1): Explore uses a users/people icon (community
// feel) — not the reference's magnifying-glass glyph. Ported from the
// standard "users" icon in the design system.
function ExploreIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 00-3-3.87" />
      <path d="M16 3.13a4 4 0 010 7.75" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 01-3.46 0" />
    </svg>
  );
}

function LogOutIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

// ── Nav item definition ────────────────────────────────────────────
// "Explore" routes to /search — per the reference, the fourth tab's
// A.tab handler maps `explore -> 'search'`; there is no separate
// community/floor screen wired into the tab bar.
const NAV_ITEMS = [
  { href: "/dashboard", label: "Home",      Icon: HomeIcon },
  { href: "/portfolio", label: "Portfolio", Icon: LayersIcon },
  { href: "/search",    label: "Explore",   Icon: ExploreIcon },
  { href: "/you",       label: "You",       Icon: UserIcon },
] as const;

export default function DashboardClientShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogOut() {
    setLoggingOut(true);
    try {
      await authClient.signOut();
    } catch (err) {
      console.error("Header logout error:", err);
    } finally {
      window.location.href = "/login";
    }
  }

  return (
    <div
      style={{
        minHeight: "100dvh",
        backgroundColor: "var(--color-dojo-app)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* ── Top header ── */}
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 40,
          backgroundColor: "var(--color-dojo-app)",
          borderBottom: "1px solid var(--color-dojo-divider)",
          display: "flex",
          alignItems: "center",
          padding: "14px 22px",
          gap: "16px",
        }}
      >
        {/* DOJO wordmark */}
        <Link href="/dashboard" style={{ textDecoration: "none" }}>
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 800,
              fontStretch: "125%",
              fontSize: "15px",
              letterSpacing: "0.26em",
              textTransform: "uppercase",
              color: "var(--color-dojo-ink)",
            }}
          >
            DOJO
          </span>
        </Link>

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Right icons */}
        <Link
          href="/search"
          style={{
            color: "rgba(255,255,255,0.6)",
            display: "flex",
            alignItems: "center",
            textDecoration: "none",
          }}
          aria-label="Search"
        >
          <SearchIcon />
        </Link>
        <button
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "rgba(255,255,255,0.6)",
            display: "flex",
            alignItems: "center",
            padding: 0,
            position: "relative",
          }}
          aria-label="Notifications"
        >
          <BellIcon />
        </button>
        <button
          onClick={handleLogOut}
          disabled={loggingOut}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--color-dojo-vermilion)",
            display: "flex",
            alignItems: "center",
            padding: 0,
            opacity: loggingOut ? 0.5 : 0.8,
          }}
          aria-label="Log Out"
          title="Log Out"
        >
          <LogOutIcon />
        </button>
      </header>

      {/* ── Scrollable content ── */}
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          /* Reserve space for the fixed bottom nav (64px nav + 16px safe area) */
          paddingBottom: "80px",
        }}
      >
        {children}
      </main>

      {/* ── Bottom navigation bar ──
          Ported from dojo-prototype/styles.css .tabbar/.tabwrap: the
          border-top lives on the bar itself (not per-button), and the
          active state is a white icon glow (drop-shadow) + a glowing
          gradient bar above the icon — not a gold top border, which is
          what this used to render instead. */}
      <nav
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 50,
          display: "flex",
          borderTop: "1px solid var(--color-dojo-stroke)",
          backgroundColor: "var(--color-dojo-card)",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}
        aria-label="Main navigation"
      >
        {/* Home + Portfolio (active state is gold per client feedback) */}
        {NAV_ITEMS.slice(0, 2).map(({ href, label, Icon }) => {
          const active = pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              style={{
                position: "relative",
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "5px",
                padding: "12px 0 10px",
                textDecoration: "none",
                color: active ? "var(--color-dojo-gold)" : "var(--color-dojo-faint)",
              }}
              aria-current={active ? "page" : undefined}
            >
              {active && <span className="dojo-tab-glow-bar" />}
              <span className={active ? "dojo-tab-icon-glow" : undefined} style={{ display: "flex" }}>
                <Icon filled={active} />
              </span>
              <span
                style={{
                  fontFamily: "var(--font-display)",
                  fontWeight: 700,
                  fontStretch: "112%",
                  fontSize: "7.5px",
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                }}
              >
                {label}
              </span>
            </Link>
          );
        })}

        {/* Centre — Scan FAB */}
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "8px 0",
          }}
        >
          <Link
            href="/scanner"
            style={{
              width: "44px",
              height: "44px",
              background: "var(--color-dojo-gold)",
              boxShadow: "3px 3px 0 0 #806A17",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#0D0D0D",
              textDecoration: "none",
            }}
            aria-label="Scan a card"
          >
            <ScanIcon />
          </Link>
        </div>

        {/* Explore + You (active state is gold per client feedback) */}
        {NAV_ITEMS.slice(2).map(({ href, label, Icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              style={{
                position: "relative",
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "5px",
                padding: "12px 0 10px",
                textDecoration: "none",
                color: active ? "var(--color-dojo-gold)" : "var(--color-dojo-faint)",
              }}
              aria-current={active ? "page" : undefined}
            >
              {active && <span className="dojo-tab-glow-bar" />}
              <span className={active ? "dojo-tab-icon-glow" : undefined} style={{ display: "flex" }}>
                <Icon />
              </span>
              <span
                style={{
                  fontFamily: "var(--font-display)",
                  fontWeight: 700,
                  fontStretch: "112%",
                  fontSize: "7.5px",
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                }}
              >
                {label}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
