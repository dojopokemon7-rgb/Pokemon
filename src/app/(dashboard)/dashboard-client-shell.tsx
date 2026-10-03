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
    <div className="dojo-shell">
      {/* ── Bottom/Side navigation bar ── */
      /* Desktop: moves to left side sidebar. Mobile: bottom bar. */}
      <nav className="dojo-shell-nav" aria-label="Main navigation">
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
