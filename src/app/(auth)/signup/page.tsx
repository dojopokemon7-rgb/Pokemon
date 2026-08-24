"use client";

/**
 * Screen 02 — Sign Up / Create Account
 *
 * Keeps all Better Auth logic intact:
 *   - authClient.signUp.email({ name, email, password })
 *   - Client-side password validation (8+ chars, 1+ number)
 *   - Loading state, server error display
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";

// ── SVG icons ──────────────────────────────────────────────────
function ArrowRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" />
    </svg>
  );
}

function ChevronLeft() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M8 2L4 6l4 4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" />
    </svg>
  );
}

function EyeIcon({ off }: { off?: boolean }) {
  return off ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00A86B" strokeWidth="2.5" strokeLinecap="square" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

// ── Password validation ─────────────────────────────────────────
function validatePassword(pw: string): string | null {
  if (pw.length < 8) return "eight characters minimum, at least one number.";
  if (!/\d/.test(pw))  return "eight characters minimum, at least one number.";
  return null;
}

// ── Component ───────────────────────────────────────────────────
export default function SignUpPage() {
  const router = useRouter();
  const [username, setUsername]   = useState("");
  const [email, setEmail]         = useState("");
  const [password, setPassword]   = useState("");
  const [password2, setPassword2] = useState("");
  const [showPw, setShowPw]       = useState(false);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);

  // Live-validate password only once the user has started typing
  const pwHint = password.length > 0 ? validatePassword(password) : null;
  const pwOk = password.length >= 8 && /\d/.test(password);

  // Confirm-password match state — ported from app.js doSignup():
  // suMismatch / suMatched. Gates the submit button the same way the
  // reference does (S.suPw2 === S.suPw as part of the overall `ok` check).
  const pwMismatch = password2.length > 0 && password2 !== password;
  const pwMatched = password2.length > 0 && password2 === password && pwOk;
  const passwordsValid = password2.length > 0 && password2 === password && pwOk;

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Client-side validation before hitting the server
    const pwError = validatePassword(password);
    if (pwError) {
      setError(pwError);
      return;
    }
    if (password2 !== password) {
      setError("passwords don't match.");
      return;
    }

    setLoading(true);

    const { error: authError } = await authClient.signUp.email({
      name: username,
      email,
      password,
    });

    if (authError) {
      setError(authError.message ?? "Sign up failed. Please try again.");
      setLoading(false);
      return;
    }

    // Successful sign-up — redirect to Create Profile (Screen 05)
    router.push("/profile");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      {/* ── Back link ── */}
      <Link href="/login" style={{ textDecoration: "none", display: "inline-block", marginBottom: "22px" }}>
        <button type="button" className="dojo-back">
          <ChevronLeft />
          sign in
        </button>
      </Link>

      {/* ── Heading ── */}
      <h1 className="dojo-heading" style={{ marginBottom: "8px" }}>create your account</h1>
      <p className="dojo-body" style={{ marginBottom: "28px" }}>
        one account for your whole collection.
      </p>

      {/* ── Form ── */}
      <form onSubmit={handleSignUp} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

        {/* Username */}
        <div className="dojo-input-wrap">
          <label htmlFor="signup-username" className="dojo-label">Username</label>
          <input
            id="signup-username"
            type="text"
            autoComplete="username"
            placeholder="pick a handle"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            disabled={loading}
            className="dojo-input"
          />
        </div>

        {/* Email */}
        <div className="dojo-input-wrap">
          <label htmlFor="signup-email" className="dojo-label">Email</label>
          <input
            id="signup-email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={loading}
            className="dojo-input"
          />
        </div>

        {/* Password */}
        <div className="dojo-input-wrap">
          <label htmlFor="signup-password" className="dojo-label">Password</label>
          <div style={{ position: "relative" }}>
            <input
              id="signup-password"
              type={showPw ? "text" : "password"}
              autoComplete="new-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={loading}
              className="dojo-input"
              style={{ paddingRight: "48px" }}
            />
            <button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              aria-label={showPw ? "Hide password" : "Show password"}
              style={{
                position: "absolute",
                right: "14px",
                top: "50%",
                transform: "translateY(-50%)",
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--color-dojo-faint)",
                padding: "4px",
                display: "flex",
                alignItems: "center",
              }}
            >
              <EyeIcon off={showPw} />
            </button>
          </div>
          {/* Password hint — always visible, turns red on violation */}
          <p
            className={pwHint ? "dojo-error" : "dojo-faint"}
            style={{ marginTop: "2px" }}
          >
            eight characters minimum, at least one number.
          </p>
        </div>

        {/* Confirm password — ported from app.js SCREENS.signup:
            field('Confirm password', 'suPw2', 'type it again', 'password')
            plus the suMismatch/suMatched messages. This field and its
            validation state were entirely missing before. */}
        <div className="dojo-input-wrap">
          <label htmlFor="signup-password2" className="dojo-label">Confirm password</label>
          <div style={{ position: "relative" }}>
            <input
              id="signup-password2"
              type={showPw ? "text" : "password"}
              autoComplete="new-password"
              placeholder="type it again"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              required
              disabled={loading}
              className="dojo-input"
              style={{ paddingRight: pwMatched ? "48px" : "16px" }}
            />
            {pwMatched && (
              <span
                style={{
                  position: "absolute",
                  right: "16px",
                  top: "50%",
                  transform: "translateY(-50%)",
                  display: "flex",
                }}
                aria-hidden="true"
              >
                <CheckIcon />
              </span>
            )}
          </div>
          {pwMismatch && (
            <p className="dojo-error" style={{ marginTop: "2px" }}>
              passwords don&apos;t match.
            </p>
          )}
          {pwMatched && (
            <p style={{ marginTop: "2px", fontSize: "11px", lineHeight: 1.5, color: "#00A86B" }}>
              passwords match.
            </p>
          )}
        </div>

        {/* Server error */}
        {error && !pwHint && !pwMismatch && (
          <p className="dojo-error dojo-shake" role="alert" key={error}>
            {error}
          </p>
        )}

        {/* Create Account button — disabled until the confirm-password
            field matches, mirroring app.js suBtnRef's opacity/
            pointer-events gate on the same `ok` condition as doSignup(). */}
        <button
          id="btn-create-account"
          type="submit"
          disabled={loading || !username.trim() || !email.includes("@") || !passwordsValid}
          className="dojo-btn dojo-btn-primary"
          style={{ marginTop: "10px" }}
        >
          {loading ? "Creating account…" : (
            <>CREATE ACCOUNT <ArrowRight /></>
          )}
        </button>
      </form>

      {/* Terms copy */}
      <p className="dojo-faint" style={{ marginTop: "14px", lineHeight: 1.6 }}>
        by continuing you agree to the terms and privacy policy.
      </p>

      {/* ── Footer links ── margin-top:auto pins to the true bottom
          (see login/page.tsx comment for the same fix + rationale). */}
      <div
        style={{
          marginTop: "auto",
          paddingTop: "26px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "14px",
        }}
      >
        <p style={{ fontSize: "12.5px", color: "var(--color-dojo-body)", margin: 0 }}>
          already in?{" "}
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
