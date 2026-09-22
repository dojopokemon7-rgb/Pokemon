"use client";

/**
 * NotificationsPanel — header bell + dropdown.
 *
 * Self-contained: renders the bell button (aria-label "Notifications") and,
 * when open, a dropdown panel anchored under it. Closes on a second bell
 * click, an outside click, or Escape.
 *
 * There is no notifications backend yet, so the list is empty and the panel
 * shows a "No new notifications" empty state. The `Notification` shape and
 * the list rendering are in place so a future GET /api/notifications can
 * populate it without a UI rewrite.
 */

import { useEffect, useRef, useState } from "react";

export interface Notification {
  id: string;
  message: string;
  /** ISO timestamp; rendered as a short relative/local time. */
  createdAt: string;
}

function BellIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 01-3.46 0" />
    </svg>
  );
}

export function NotificationsPanel({
  notifications = [],
}: {
  notifications?: Notification[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click (anywhere outside the bell + panel) or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} style={{ position: "relative", display: "flex" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
        aria-expanded={open}
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
      >
        <BellIcon />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          data-testid="notifications-panel"
          style={{
            position: "absolute",
            top: "calc(100% + 10px)",
            right: 0,
            zIndex: 100,
            width: "280px",
            maxHeight: "60vh",
            overflowY: "auto",
            background: "var(--color-dojo-card)",
            border: "1px solid var(--color-dojo-stroke)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            animation: "dojo-fade-in 160ms ease-out both",
          }}
        >
          <div
            style={{
              padding: "12px 14px",
              borderBottom: "1px solid var(--color-dojo-divider)",
              fontFamily: "var(--font-display)",
              fontWeight: 800,
              fontSize: "10px",
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: "var(--color-dojo-body)",
            }}
          >
            Notifications
          </div>

          {notifications.length === 0 ? (
            <div
              style={{
                padding: "22px 14px",
                textAlign: "center",
                fontSize: "12px",
                color: "var(--color-dojo-faint)",
              }}
            >
              No new notifications
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {notifications.map((n) => (
                <li
                  key={n.id}
                  data-testid="notification-item"
                  style={{
                    padding: "12px 14px",
                    borderBottom: "1px solid var(--color-dojo-divider)",
                  }}
                >
                  <div style={{ fontSize: "13px", color: "var(--color-dojo-ink)", lineHeight: 1.4 }}>
                    {n.message}
                  </div>
                  <div style={{ marginTop: "4px", fontSize: "10px", color: "var(--color-dojo-faint)" }}>
                    {new Date(n.createdAt).toLocaleString()}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
