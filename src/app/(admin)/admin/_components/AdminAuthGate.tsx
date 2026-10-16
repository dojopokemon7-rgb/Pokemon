"use client";

/**
 * Admin login + OTP gate (client component).
 *
 * Rendered by (admin)/admin/layout.tsx IN PLACE of the panel whenever there is
 * no valid admin session — so an unauthenticated visitor to /admin sees THIS
 * form, never a redirect to the public /login.
 *
 * Two phases, both of which perform NO credential logic in the browser:
 *   (a) email + password → POST /api/admin-auth/login. On {step:"otp"} advance.
 *   (b) 6-digit OTP → POST /api/admin-auth/verify-otp. On {ok:true} call
 *       router.refresh() so the SERVER layout re-reads the now-valid admin
 *       session cookie and renders the panel.
 *
 * All secrets live server-side (admin-credentials / admin-session / env). This
 * component only issues fetches and renders state — it never sees ADMIN_EMAIL/
 * ADMIN_PASSWORD/ADMIN_SESSION_SECRET.
 *
 * Styling: admin-panel Tailwind + CSS-var palette (the admin panel is the
 * Tailwind exception per AGENTS.md), gold-on-dark, square corners, shared
 * ArrowRight CTA.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "@/components/ArrowRight";

type Phase = "password" | "otp";

export default function AdminAuthGate() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("password");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin-auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        setPassword("");
        setCode("");
        setPhase("otp");
        setNotice("A verification code was sent to the admin email.");
      } else if (res.status === 429) {
        setError("Too many attempts. Please wait a minute and try again.");
      } else {
        // Generic — never reveal which field was wrong or whether the email exists.
        setError("Invalid credentials.");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function submitOtp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin-auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ code }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        relogin?: boolean;
        error?: string;
        remaining?: number;
      };
      if (res.ok && data.ok) {
        // Server now holds a valid admin session cookie — re-render the layout.
        router.refresh();
        return;
      }
      if (data.relogin) {
        // Attempt cap hit (or nonce gone) → force re-entering the password.
        setPhase("password");
        setCode("");
        setError("Too many attempts. Please sign in again.");
      } else if (res.status === 429) {
        setError("Too many attempts. Please wait a minute and try again.");
      } else {
        const remainingNote =
          typeof data.remaining === "number" ? ` ${data.remaining} attempt(s) left.` : "";
        setError(`Invalid or expired code.${remainingNote}`);
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function resendCode() {
    // Re-run the password step server-side to mint a fresh challenge. The
    // password field was cleared after phase (a), so bounce the admin back to
    // re-enter it rather than caching the password in client state.
    setPhase("password");
    setCode("");
    setError(null);
    setNotice("Enter your credentials again to receive a new code.");
  }

  return (
    <div
      className="h-screen w-screen flex items-center justify-center px-6"
      style={{ background: "var(--color-dojo-app)", color: "var(--color-dojo-ink)" }}
    >
      <div
        className="w-full max-w-[380px] px-8 py-10"
        style={{
          background: "var(--color-dojo-surface, rgba(255,255,255,0.02))",
          border: "1px solid var(--color-dojo-stroke)",
        }}
      >
        {/* Brand */}
        <div className="mb-8">
          <div
            className="dojo-heading"
            style={{ fontSize: "26px", letterSpacing: "0.08em", color: "var(--color-dojo-gold)" }}
          >
            DOJO
          </div>
          <div className="dojo-step-label" style={{ marginTop: "4px", fontSize: "9px" }}>
            Admin Panel · Secure Login
          </div>
        </div>

        {notice && (
          <p
            role="status"
            style={{ marginBottom: "16px", fontSize: "12px", color: "var(--color-dojo-jade)" }}
          >
            {notice}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="dojo-shake"
            key={error}
            style={{ marginBottom: "16px", fontSize: "12px", color: "var(--color-dojo-danger, #e5484d)" }}
          >
            {error}
          </p>
        )}

        {phase === "password" ? (
          <form onSubmit={submitPassword} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div className="dojo-input-wrap">
              <label htmlFor="admin-email" className="dojo-label">
                Admin Email
              </label>
              <input
                id="admin-email"
                type="email"
                autoComplete="username"
                className="dojo-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={loading}
              />
            </div>
            <div className="dojo-input-wrap">
              <label htmlFor="admin-password" className="dojo-label">
                Password
              </label>
              <input
                id="admin-password"
                type="password"
                autoComplete="current-password"
                className="dojo-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={loading}
              />
            </div>
            <button
              id="admin-sign-in"
              type="submit"
              disabled={loading || !email || !password}
              className="dojo-btn dojo-btn-primary"
              style={{ marginTop: "8px" }}
            >
              {loading ? "Verifying…" : (<>CONTINUE <ArrowRight /></>)}
            </button>
          </form>
        ) : (
          <form onSubmit={submitOtp} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div className="dojo-input-wrap">
              <label htmlFor="admin-otp" className="dojo-label">
                Verification Code
              </label>
              <input
                id="admin-otp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                className="dojo-input"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                required
                disabled={loading}
              />
            </div>
            <button
              id="admin-verify-otp"
              type="submit"
              disabled={loading || code.length !== 6}
              className="dojo-btn dojo-btn-primary"
              style={{ marginTop: "8px" }}
            >
              {loading ? "Verifying…" : (<>VERIFY <ArrowRight /></>)}
            </button>
            <button
              type="button"
              onClick={resendCode}
              disabled={loading}
              className="dojo-link"
              style={{ fontSize: "10px", alignSelf: "center" }}
            >
              Resend code
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
