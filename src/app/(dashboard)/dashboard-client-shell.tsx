"use client";

/**
 * Dashboard Client Shell — (dashboard)
 *
 * Provides:
 *   - Top header: page-injected left slot + notifications bell (no brand
 *     logo lives here — the brand mark sits in the desktop sidebar below)
 *   - Nav bar: fixed bottom tab bar on mobile, static left sidebar on desktop
 *     (Home · Portfolio · Explore · You). On desktop the Dojo brand mark +
 *     wordmark render at the TOP of the sidebar (`.dojo-shell-logo`, a Link
 *     back to /dashboard), hidden on mobile where the bottom bar has no room.
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
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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

// (SearchIcon removed — the top-line search icon was dropped per plan §4.)

// QA D4: chevron for the desktop sidebar collapse toggle. Points LEFT when
// expanded (click to collapse toward the rail) and RIGHT when collapsed
// (click to expand). One glyph, flipped by the `collapsed` flag.
function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="square"
      aria-hidden="true"
      style={{ transform: collapsed ? "none" : "scaleX(-1)" }}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

// The Dojo brand mark — torii-gate glyph path taken verbatim from the
// reference prototype (dojo-prototype/data.js: DOJO_PATH), the SAME path the
// login screen renders. Drawn off-white (#F2F1ED) so it reads on the dark
// sidebar, mirroring the login page's DojoMark treatment. Decorative — the
// accessible name lives on the wrapping <Link>, so this is aria-hidden.
const DOJO_MARK_PATH =
  "M19.7373 0.022325C46.3088 -0.0059576 72.885 0.0176164 99.4565 0.0129026C120.301 0.0741816 141.164 -0.10495 161.999 0.107169C171.313 9.16231 180.255 18.6087 189.489 27.744C202.575 41.0085 215.59 54.3485 228.708 67.58C228.666 80.5712 228.67 93.5717 228.618 106.558C226.064 96.6262 221.915 86.9913 215.561 78.8836C213.143 75.419 209.815 72.7699 206.963 69.6871C189.9 52.6327 173.01 35.4039 156.008 18.2929C154.933 17.5764 153.448 18.0902 152.222 17.9394C113.819 17.9582 75.4116 17.9205 37.0038 17.9676C37.0085 66.7504 37.0274 115.533 36.9944 164.316C44.1923 164.377 51.3949 164.288 58.5976 164.344C58.6306 123.485 58.6211 82.6263 58.6117 41.7674C87.6862 41.791 116.756 41.8051 145.831 41.7627C172.454 68.5369 199.049 95.3394 225.913 121.873C226.893 122.863 228.081 123.688 228.892 124.838C231.267 138.489 230.428 152.607 227.346 166.084C221.51 190.166 207.769 212.42 188.292 227.839C172.081 240.773 151.892 249.046 131.086 249.96C106.838 250.031 82.5906 249.989 58.343 249.974C58.3572 233.179 58.3383 216.384 58.3477 199.589C78.3388 199.613 98.3252 199.613 118.316 199.58C129.106 199.311 139.764 195.992 149.017 190.487C164.242 181.512 175.838 166.715 181.099 149.859C183.013 143.589 184.224 137.061 184.182 130.49C184.172 121.868 184.224 113.247 184.135 104.625C169.244 89.4236 154.08 74.4291 139.142 59.2508C118.085 59.2696 97.0336 59.2696 75.9772 59.2602C76.1422 62.5881 75.619 65.9066 75.9537 69.2204C76.0197 70.9456 75.9442 72.6709 75.982 74.4008C75.9537 78.6574 75.9725 82.9139 75.9772 87.1704C75.9961 88.7165 75.9914 90.2579 75.9772 91.804C75.9867 103.914 75.9489 116.023 75.9961 128.128C75.9442 130.33 75.9631 132.531 75.982 134.732C75.9631 137.084 75.9584 139.437 75.9866 141.794C75.9442 142.581 75.9395 143.373 75.9725 144.165C75.9537 145.107 75.9395 146.05 75.9678 146.998C75.9207 150.457 75.784 153.903 75.9772 157.363C76.0149 159.404 75.8971 161.441 75.784 163.482C75.8217 164.74 75.8028 165.999 75.7745 167.262C75.7274 170.265 75.9207 173.258 75.9772 176.261C75.718 178.09 75.7887 179.942 75.784 181.785C61.6709 181.771 47.5579 181.78 33.4449 181.78C28.882 181.672 24.3191 182.087 19.7609 181.743C19.7467 121.171 19.775 60.5989 19.7373 0.022325ZM201.392 121.666C201.34 123.82 201.368 125.974 201.382 128.133C201.26 140.672 198.691 153.21 193.567 164.669C187.462 178.424 177.936 190.704 165.911 199.778C151.93 210.445 134.569 216.841 116.921 216.912C103.152 216.931 89.3832 216.879 75.6143 216.94C75.586 222.3 75.6284 227.659 75.5907 233.019C91.8673 232.962 108.144 233 124.421 232.991C132.052 233.184 139.717 232.265 147.084 230.233C173.062 223.016 194.712 203.087 205.441 178.523C211.503 164.269 214.406 148.511 212.804 133.049C209.033 129.222 205.116 125.54 201.392 121.666Z";

function DojoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 250 250" aria-hidden="true" focusable="false">
      <path d={DOJO_MARK_PATH} fill="#F2F1ED" />
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
  const queryClient = useQueryClient();

  // QA D4: desktop sidebar collapse (icon-only rail), persisted across
  // navigation/reload via localStorage (`dojo_nav_collapsed`). Hydration-safe:
  // this is an SSR'd client component, so reading localStorage in the useState
  // initializer would make the client's first render disagree with the server's
  // (always `false`) and trip a hydration mismatch. Mirror the portfolio QA #9a
  // pattern — start `false` (server parity), then read the stored value AFTER
  // mount. A brief expand→collapse flash on first load for collapsed users is
  // acceptable and hydration-safe. Below 768px the rail class is a no-op (the
  // mobile bottom bar has no collapse concept — gated purely in CSS).
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem("dojo_nav_collapsed") === "true") setCollapsed(true);
    } catch {
      // localStorage can throw (private mode / blocked storage) — ignore and
      // keep the expanded default.
    }
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("dojo_nav_collapsed", String(next));
      } catch {
        // Ignore persistence failures — the in-session toggle still works.
      }
      return next;
    });
  };

  // Warm the destination tab's data on hover/focus of its nav link, so the
  // page it opens reads from cache instead of firing its query on mount.
  // <Link prefetch> already warms the route's JS; this warms the DATA.
  // Dashboard / Portfolio / You all read the same collection endpoint under
  // shared query keys, so one fetch primes every one of them. Best-effort:
  // prefetchQuery is a no-op if the data is already fresh (staleTime), and
  // a failed fetch just means the page loads it normally.
  const prefetchForHref = (href: string) => {
    const fetchCollection = () =>
      fetch("/api/users/me/collection", { credentials: "include" }).then((r) => {
        if (!r.ok) throw new Error("prefetch failed");
        return r.json();
      });
    if (href === "/portfolio") {
      queryClient.prefetchQuery({ queryKey: ["portfolio-collection"], queryFn: fetchCollection });
    } else if (href === "/dashboard" || href === "/you") {
      // The dashboard/you pages read ["collection"] as CollectionItem[]; the
      // endpoint returns { items }, so map to the array shape they expect.
      queryClient.prefetchQuery({
        queryKey: ["collection"],
        queryFn: () => fetchCollection().then((d) => d.items ?? []),
      });
    }
    // /search is an infinite query (trending) — prefetching an infinite
    // query needs its full pageParam contract; <Link prefetch> already warms
    // its bundle, and the trending API is Redis-cached, so we skip the data
    // prewarm here rather than risk a cache-shape mismatch.
  };

  // Defect 5: the scanner is an immersive, locked camera view — no app
  // header, no bottom tab bar. Render it full-bleed in its own frame (the page
  // provides its own close "X"). Still width-constrained to the phone frame on
  // desktop for consistency. SCROLL: minHeight (not a hard height) + overflowY
  // auto — the scan RESULTS render BELOW the camera frame; on short mobile
  // viewports a `height:100dvh; overflow:hidden` wrapper clipped them off-screen
  // and unreachable (the bug: works on laptop's tall viewport, not on mobile).
  if (pathname === "/scanner" || pathname.startsWith("/scanner/")) {
    return (
      <div
        style={{
          // `position: fixed; inset: 0` is REQUIRED: globals.css locks
          // `body { overflow: hidden }`, so a normal-flow child can't scroll —
          // its overflow is clipped by body with no scroll region. Pinning this
          // wrapper to the viewport with fixed + its OWN overflowY:auto creates
          // an INDEPENDENT scroll region that escapes the body lock, so the scan
          // results below the camera are reachable on short mobile viewports.
          position: "fixed",
          inset: 0,
          overflowY: "auto",
          WebkitOverflowScrolling: "touch",
          backgroundColor: "var(--color-dojo-app)",
          maxWidth: SCANNER_MAX_WIDTH,
          marginInline: "auto",
          borderInline: "1px solid var(--color-dojo-divider)",
        }}
      >
        {children}
      </div>
    );
  }

  return (
    <div className="dojo-shell">
      {/* ── Bottom/Side navigation bar ── */
      /* Desktop: moves to left side sidebar. Mobile: bottom bar. */}
      <nav
        className={`dojo-shell-nav${collapsed ? " dojo-shell-nav--collapsed" : ""}`}
        aria-label="Main navigation"
      >
        {/* Brand mark + DOJO wordmark — desktop sidebar only. `.dojo-shell-nav`
            is the SAME element in both layouts (bottom bar on mobile, left
            sidebar on desktop), so this is gated to >=768px via CSS
            (`.dojo-shell-logo` is display:none below the breakpoint). Links
            home; the accessible name lives here, the SVG parts are decorative. */}
        <Link href="/dashboard" className="dojo-shell-logo" aria-label="Dojo home" prefetch>
          <DojoMark />
          <span className="dojo-shell-logo-word" aria-hidden="true">DOJO</span>
        </Link>

        {/* QA D4: desktop-only collapse toggle. `.dojo-shell-nav-toggle` is
            display:none below 768px (same gating approach as `.dojo-shell-logo`),
            so the mobile bottom bar never shows it. aria-expanded + a
            state-reflecting aria-label keep it announced correctly to AT. */}
        <button
          type="button"
          className="dojo-shell-nav-toggle"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <ChevronIcon collapsed={collapsed} />
        </button>

        {NAV_ITEMS.map(({ href, label, Icon }) => {
          const active =
            href === "/dashboard"
              ? pathname === href
              : pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              prefetch
              onMouseEnter={() => prefetchForHref(href)}
              onFocus={() => prefetchForHref(href)}
              className="dojo-shell-nav-item"
              style={{
                color: active ? "#fff" : "var(--color-dojo-faint)",
              }}
              aria-current={active ? "page" : undefined}
              /* QA D4: in the collapsed rail the visible label is hidden, so
                 give every link an accessible name + a sighted tooltip. */
              aria-label={label}
              title={label}
            >
              {active && <span className="dojo-tab-glow-bar" />}
              <span className={`dojo-shell-nav-item-icon ${active ? "dojo-tab-icon-glow" : ""}`}>
                <Icon filled={active} />
              </span>
              <span className="dojo-shell-nav-item-label">
                {label}
              </span>
            </Link>
          );
        })}
      </nav>

      {/* ── Main Layout Area ── */}
      <div className="dojo-shell-content">
        <header className="dojo-shell-header">
          {/* Left slot — page-injected (dashboard collection selector). */}
          <div style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
            {headerLeft}
          </div>

          {/* Spacer pushes the icons to the right. */}
          <div style={{ flex: 1 }} />

          {/* Right icons. The top-line Search icon was REMOVED per the plan
              (§4): it duplicated the bottom-nav "Explore" tab, which already
              routes to /search. Notifications remain. */}
          <NotificationsPanel />
        </header>

        <main className="dojo-shell-main dojo-scroll-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}
