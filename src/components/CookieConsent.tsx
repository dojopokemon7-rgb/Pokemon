"use client";

/**
 * CookieConsent — bottom consent banner (GDPR/ePrivacy, users are global).
 *
 * PostHog MUST NOT load until the user clicks Accept. This banner
 * persists the choice in localStorage (`dojo-analytics-consent` = granted|denied)
 * and fires a `dojo-consent-changed` event so <AnalyticsProvider/> reacts WITHOUT
 * a page reload. On Decline / no-choice nothing loads — no cookies, no recording.
 *
 * Design (RULE 10): inline styles + `.dojo-*` classes + `--color-dojo-*` tokens,
 * square corners, dashboard/auth convention. Accessibility: role="dialog", real
 * <button>s, keyboard-focusable, dismissible (Decline closes it).
 *
 * All localStorage/window access is guarded by `typeof window` and happens in an
 * effect (never during render) to avoid a hydration mismatch.
 */

import { useEffect, useState } from "react";
import {
  CONSENT_STORAGE_KEY,
  parseConsent,
  type ConsentValue,
} from "@/lib/utils/analytics-consent";

/** Event name both the banner and the provider agree on (no prop drilling). */
export const CONSENT_CHANGED_EVENT = "dojo-consent-changed";

/** Write a choice, then notify the provider in the same tick. */
function writeConsent(value: ConsentValue) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, value);
  } catch {
    // Private-mode / storage-disabled: the banner still closes for this
    // session; worst case it re-shows next load. Never throw from a click.
  }
  window.dispatchEvent(new Event(CONSENT_CHANGED_EVENT));
}

/**
 * Minimal re-show hook: clear the stored choice so the banner reappears (for a
 * future "change cookie settings" link). Intentionally NOT a settings UI.
 */
export function resetConsent() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(CONSENT_STORAGE_KEY);
  } catch {
    // ignore — see writeConsent
  }
  window.dispatchEvent(new Event(CONSENT_CHANGED_EVENT));
}

export default function CookieConsent() {
  // `null` until the effect reads storage → banner stays hidden during SSR and
  // first paint, so there's no hydration mismatch and no flash on repeat visits.
  const [choice, setChoice] = useState<ConsentValue | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const read = () => {
      try {
        setChoice(parseConsent(window.localStorage.getItem(CONSENT_STORAGE_KEY)));
      } catch {
        setChoice(null);
      }
      setLoaded(true);
    };
    read();
    // Re-read if resetConsent() runs elsewhere so the banner can reappear.
    window.addEventListener(CONSENT_CHANGED_EVENT, read);
    return () => window.removeEventListener(CONSENT_CHANGED_EVENT, read);
  }, []);

  // Show only after we've read storage AND no choice exists yet.
  if (!loaded || choice !== null) return null;

  const accept = () => {
    writeConsent("granted");
    setChoice("granted");
  };
  const decline = () => {
    writeConsent("denied");
    setChoice("denied");
  };

  return (
    <div
      role="dialog"
      aria-label="Analytics cookie consent"
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 200,
        background: "var(--color-dojo-card)",
        borderTop: "1px solid var(--color-dojo-stroke)",
        padding: "16px",
        paddingBottom: "calc(16px + env(safe-area-inset-bottom, 0px))",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
      }}
    >
      <p className="dojo-body" style={{ margin: 0, maxWidth: "560px" }}>
        We use analytics to improve Dojo. Accept / Decline.
      </p>
      <div style={{ display: "flex", gap: "8px", flex: "none" }}>
        <button
          type="button"
          className="dojo-btn dojo-btn-outline-sm"
          onClick={decline}
        >
          Decline
        </button>
        <button
          type="button"
          className="dojo-btn dojo-btn-primary"
          onClick={accept}
        >
          Accept
        </button>
      </div>
    </div>
  );
}
