"use client";

/**
 * Forgot Password — Request Reset Link
 *
 * The reference prototype's "Forgot password?" link (app.js
 * SCREENS.signin) is wired to a no-op (`data-a="noop"`) — the design
 * file never specifies a request/reset flow. This page implements a
 * real one using Better Auth's built-in forgetPassword client method,
 * styled consistently with the rest of the auth screens (same
 * dojo-input/dojo-btn primitives, back link, margin-top:auto footer).
 *
 * Calls: authClient.requestPasswordReset({ email, redirectTo: "/reset-password" })
 * The actual email delivery is handled by sendResetPassword in
 * src/lib/auth.ts (console-logged in dev — no email provider wired up
 * yet, same plug-and-play pattern as the SMS OTP dev-mode logging).
 */

import { useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { ArrowRight } from "@/components/ArrowRight";

function ChevronLeft() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M8 2L4 6l4 4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00A86B" strokeWidth="2.5" strokeLinecap="square" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export default function ForgotPasswordPage() {
  const [email, setEmail]     = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [sent, setSent]       = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error: authError } = await authClient.requestPasswordReset({
      email,
      redirectTo: "/reset-password",
    });

    setLoading(false);

    if (authError) {
      setError(authError.message ?? "Something went wrong. Please try again.");
      return;
    }

    // Better Auth returns success even if the email doesn't exist
    // (prevents account enumeration) — always show the same confirmation.
    setSent(true);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      {/* ── Back ── */}
      <Link href="/login" style={{ textDecoration: "none", display: "inline-block", marginBottom: "22px" }}>
        <button type="button" className="dojo-back">
          <ChevronLeft />
          sign in
        </button>
      </Link>

      {/* ── Heading ── */}
      <h1 className="dojo-heading" style={{ marginBottom: "8px" }}>forgot password</h1>
      <p className="dojo-body" style={{ marginBottom: "28px" }}>
        enter your email and we&apos;ll send you a link to reset it.
      </p>

      {sent ? (
        <div
          style={{
            background: "rgba(0, 168, 107, 0.12)",
            border: "1px solid #00A86B",
            padding: "12px 14px",
            display: "flex",
            alignItems: "center",
            gap: "10px",
          }}
        >
          <CheckIcon />
          <span style={{ fontSize: "13px", color: "#00A86B", fontWeight: 600 }}>
            If an account exists for {email}, a reset link is on its way.
          </span>
        </div>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div className="dojo-input-wrap">
            <label htmlFor="forgot-email" className="dojo-label">Email</label>
            <input
              id="forgot-email"
              type="email"
              autoComplete="email"
              placeholder="you@domain.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={loading}
              className="dojo-input"
            />
          </div>

          {error && (
            <p className="dojo-error dojo-shake" role="alert" key={error}>
              {error}
            </p>
          )}

          <button
            id="btn-send-reset-link"
            type="submit"
            disabled={loading || !email}
            className="dojo-btn dojo-btn-primary"
            style={{ marginTop: "8px" }}
          >
            {loading ? "Sending…" : (
              <>SEND RESET LINK <ArrowRight /></>
            )}
          </button>
        </form>
      )}

      {/* ── Footer ── margin-top:auto pins to the true bottom of the
          screen (same pattern as login/signup/otp pages). */}
      <div style={{ marginTop: "auto", paddingTop: "26px", display: "flex", flexDirection: "column", alignItems: "center", gap: "14px" }}>
        <p style={{ fontSize: "12.5px", color: "var(--color-dojo-body)", margin: 0 }}>
          remembered it?{" "}
          <Link href="/login" className="dojo-link">
            Sign in ›
          </Link>
        </p>
        <button type="button" className="dojo-link" style={{ fontSize: "9px", letterSpacing: "0.18em" }}>
          NEED HELP?
        </button>
      </div>
    </div>
  );
}
