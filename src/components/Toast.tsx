"use client";

/**
 * Toast — small, auto-dismissing status message.
 *
 * Used across the app for:
 *   - Auth timeout snackbars ("Try again")
 *   - "Coming in Week 4" placeholders (Google/Meta OAuth, Filters)
 *   - Post-action confirmations ("Added Charizard to your portfolio")
 *
 * Deliberately dumb: no context provider, no queueing, no priorities.
 * Parents own the visibility state via a `message: string | null` field
 * and unmount the toast to dismiss. `duration` ms after mount, the
 * component calls `onDismiss` to let the parent clear the message.
 */

import { useEffect, useState } from "react";

export function Toast({
  message,
  onDismiss,
  duration = 2600,
  tone = "neutral",
}: {
  message: string;
  onDismiss: () => void;
  duration?: number;
  tone?: "neutral" | "error";
}) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, duration);
    return () => clearTimeout(timer);
  }, [message, onDismiss, duration]);

  const borderColor =
    tone === "error"
      ? "var(--color-dojo-vermilion)"
      : "var(--color-dojo-stroke)";

  return (
    <div
      role="status"
      style={{
        position: "fixed",
        left: "50%",
        bottom: "88px",
        transform: "translateX(-50%)",
        zIndex: 95,
        background: "var(--color-dojo-card)",
        border: `1px solid ${borderColor}`,
        padding: "10px 16px",
        color: "var(--color-dojo-ink)",
        fontFamily: "var(--font-display)",
        fontWeight: 700,
        fontSize: "12px",
        letterSpacing: "0.06em",
        boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        animation: "dojo-fade-up 200ms ease-out both",
        maxWidth: "calc(100vw - 40px)",
        textAlign: "center",
      }}
    >
      {message}
    </div>
  );
}

/**
 * Convenience hook: show a timeout toast after `ms` while a
 * long-running action is still `pending`. Auto-clears when `pending`
 * flips back to false (i.e. the action completed or errored).
 *
 * @example
 * ```tsx
 * const [toast, setToast] = useTimeoutToast(loading, "Try again — this is taking longer than expected.");
 * return <>{toast && <Toast message={toast} onDismiss={() => setToast(null)} />}</>;
 * ```
 */
export function useTimeoutToast(
  pending: boolean,
  message: string,
  ms: number = 3000
): [string | null, (v: string | null) => void] {
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!pending) {
      // The action finished — clear any lingering timeout toast so the
      // user isn't left staring at "Try again" after a successful login.
      setToast(null);
      return;
    }
    const timer = setTimeout(() => setToast(message), ms);
    return () => clearTimeout(timer);
  }, [pending, message, ms]);

  return [toast, setToast];
}
