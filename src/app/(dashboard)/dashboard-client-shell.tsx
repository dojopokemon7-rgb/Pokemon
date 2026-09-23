"use client";

/**
 * Dashboard Client Shell — (dashboard)
 *
 * Provides:
 *   - Top header: DOJO wordmark + search + bell icons + log out button
 *   - Fixed bottom nav: Home · Portfolio · Explore · You
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
import { NotificationsPanel } from "@/components/NotificationsPanel";
import { HeaderSlotProvider, useHeaderLeft } from "./header-slot";

/** The scanner stays phone-width: it's an immersive, locked camera view that
 *  would look wrong stretched across a desktop viewport. Everything else is
 *  full-width (a proper desktop web app, no centered frame). */
const SCANNER_MAX_WIDTH = 480;

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
  // Provider wraps the whole shell so any page can inject a control into
  // the header's left slot (see header-slot.tsx).
  return (
    <HeaderSlotProvider>
      <ShellInner>{children}</ShellInner>
    </HeaderSlotProvider>
  );
}

function ShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const headerLeft = useHeaderLeft();

  // Defect 5: the scanner is an immersive, locked camera view — no app
  // header, no bottom tab bar, and no scrolling. Render it full-bleed in
  // its own locked frame (the page provides its own close "X"). Still
  // width-constrained to the phone frame on desktop for consistency.
  if (pathname === "/scanner" || pathname.startsWith("/scanner/")) {
    return (
      <div
        style={{
          height: "100dvh",
          overflow: "hidden",
          backgroundColor: "var(--color-dojo-app)",
          maxWidth: SCANNER_MAX_WIDTH,
          marginInline: "auto",
          position: "relative",
          borderInline: "1px solid var(--color-dojo-divider)",
        }}
      >
        {children}
      </div>
    );
  }

  return (
    <div
      style={{
        /* Fixed to the viewport height so the shell itself never
           scrolls — only <main> below does (Phase 2 QA: hide scroll). */
        height: "100dvh",
        overflow: "hidden",
        backgroundColor: "var(--color-dojo-app)",
        display: "flex",
        flexDirection: "column",
        /* Full-width desktop web app — the shell spans the entire viewport
           (no centered frame, no side gutters). Content breathes via the
           header/main horizontal padding, and the grids inside go adaptive
           so wide screens fill with more columns. */
        width: "100%",
        position: "relative",
      }}
    >
      {/* ── Top header ── (full-width; padding scales up on desktop)
          No wordmark, no username, no bottom divider — it blends into the
          content. Left slot hosts a page-injected control (e.g. the
          dashboard collection selector); icons stay pinned right, so the
          selector and icons share one horizontal line. */}
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 40,
          backgroundColor: "var(--color-dojo-app)",
          display: "flex",
          alignItems: "center",
          padding: "14px clamp(16px, 4vw, 48px)",
          gap: "16px",
        }}
      >
        {/* Left slot — page-injected (dashboard collection selector). */}
        <div style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
          {headerLeft}
        </div>

        {/* Spacer pushes the icons to the right. */}
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
        <NotificationsPanel />
      </header>

      {/* ── Scrollable content ──
          Only region that scrolls; scrollbar hidden via
          .dojo-scroll-hidden. `overscrollBehavior: contain` keeps the
          scroll from chaining to the (now locked) body. */}
      <main
        className="dojo-scroll-hidden"
        style={{
          flex: 1,
          overflowY: "auto",
          overscrollBehavior: "contain",
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
          what this used to render instead.
          `prefetch` is set so every tab's RSC payload is fetched while
          the shell is idle — tab switches then render instantly instead
          of waiting on a router round-trip (Phase 1 QA: tab switching
          delay). */}
      <nav
        style={{
          position: "fixed",
          bottom: 0,
          /* Full-width bar spanning the whole viewport on every screen
             size — no centered frame / side gutters. */
          left: 0,
          right: 0,
          width: "100%",
          zIndex: 50,
          display: "flex",
          borderTop: "1px solid var(--color-dojo-stroke)",
          backgroundColor: "var(--color-dojo-card)",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}
        aria-label="Main navigation"
      >
        {/* Four evenly-spaced tabs. Each item is `flex: 1`, so the row
            divides cleanly in four regardless of viewport width.
            The center scan FAB was removed — scanner is still reachable
            from the search page's toolbar. */}
        {NAV_ITEMS.map(({ href, label, Icon }) => {
          // Home only matches exactly (avoid matching every /dashboard/*
          // subroute that layout might host); every other tab matches
          // itself or a nested route (e.g. /portfolio/x still lights
          // "Portfolio" gold).
          const active =
            href === "/dashboard"
              ? pathname === href
              : pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              prefetch
              style={{
                position: "relative",
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "4px",
                padding: "12px 0 10px",
                textDecoration: "none",
                color: active ? "#fff" : "var(--color-dojo-faint)",
              }}
              aria-current={active ? "page" : undefined}
            >
              {active && <span className="dojo-tab-glow-bar" />}
              <span
                className={active ? "dojo-tab-icon-glow" : undefined}
                style={{ display: "flex" }}
              >
                <Icon filled={active} />
              </span>
              <span
                style={{
                  fontFamily: "var(--font-display)",
                  fontWeight: 800,
                  fontSize: "8.5px",
                  letterSpacing: "0.16em",
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
