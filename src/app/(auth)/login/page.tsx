"use client";

/**
 * Screen 01 — Sign In
 *
 * Keeps all Better Auth logic intact:
 *   - authClient.signIn.email({ email, password })
 *   - Loading state, server error display
 *   - Verified banner display when redirected from /verify-otp
 */

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { Toast, useTimeoutToast } from "@/components/Toast";
import { ArrowRight } from "@/components/ArrowRight";

// ── SVG icons ──────────────────────────────────────────────────
// Note: ArrowRight is imported above from @/components/ArrowRight, the
// SINGLE canonical arrow used on every primary CTA in the app. Never
// re-implement it locally — if the arrow needs to change, edit that
// one component so every button stays visually in sync.

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00A86B" strokeWidth="2.5" strokeLinecap="square" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}

function FacebookIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="#1877F2" aria-hidden="true">
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
    </svg>
  );
}

// The real Dojo mark path, taken verbatim from the reference prototype
// (dojo-prototype/data.js: DOJO_PATH), rendered off-white (#F2F1ED) as in
// the reference's dojoMark() helper — not a hand-drawn approximation, and
// not gold (the mark itself is never gold in the reference; only the CTA
// buttons and accent text are). Draws its outline then fills on mount,
// matching dojo-prototype/styles.css .mark / @keyframes dojo-draw,dojo-fill-in.
const DOJO_MARK_PATH =
  "M19.7373 0.022325C46.3088 -0.0059576 72.885 0.0176164 99.4565 0.0129026C120.301 0.0741816 141.164 -0.10495 161.999 0.107169C171.313 9.16231 180.255 18.6087 189.489 27.744C202.575 41.0085 215.59 54.3485 228.708 67.58C228.666 80.5712 228.67 93.5717 228.618 106.558C226.064 96.6262 221.915 86.9913 215.561 78.8836C213.143 75.419 209.815 72.7699 206.963 69.6871C189.9 52.6327 173.01 35.4039 156.008 18.2929C154.933 17.5764 153.448 18.0902 152.222 17.9394C113.819 17.9582 75.4116 17.9205 37.0038 17.9676C37.0085 66.7504 37.0274 115.533 36.9944 164.316C44.1923 164.377 51.3949 164.288 58.5976 164.344C58.6306 123.485 58.6211 82.6263 58.6117 41.7674C87.6862 41.791 116.756 41.8051 145.831 41.7627C172.454 68.5369 199.049 95.3394 225.913 121.873C226.893 122.863 228.081 123.688 228.892 124.838C231.267 138.489 230.428 152.607 227.346 166.084C221.51 190.166 207.769 212.42 188.292 227.839C172.081 240.773 151.892 249.046 131.086 249.96C106.838 250.031 82.5906 249.989 58.343 249.974C58.3572 233.179 58.3383 216.384 58.3477 199.589C78.3388 199.613 98.3252 199.613 118.316 199.58C129.106 199.311 139.764 195.992 149.017 190.487C164.242 181.512 175.838 166.715 181.099 149.859C183.013 143.589 184.224 137.061 184.182 130.49C184.172 121.868 184.224 113.247 184.135 104.625C169.244 89.4236 154.08 74.4291 139.142 59.2508C118.085 59.2696 97.0336 59.2696 75.9772 59.2602C76.1422 62.5881 75.619 65.9066 75.9537 69.2204C76.0197 70.9456 75.9442 72.6709 75.982 74.4008C75.9537 78.6574 75.9725 82.9139 75.9772 87.1704C75.9961 88.7165 75.9914 90.2579 75.9772 91.804C75.9867 103.914 75.9489 116.023 75.9961 128.128C75.9442 130.33 75.9631 132.531 75.982 134.732C75.9631 137.084 75.9584 139.437 75.9866 141.794C75.9442 142.581 75.9395 143.373 75.9725 144.165C75.9537 145.107 75.9395 146.05 75.9678 146.998C75.9207 150.457 75.784 153.903 75.9772 157.363C76.0149 159.404 75.8971 161.441 75.784 163.482C75.8217 164.74 75.8028 165.999 75.7745 167.262C75.7274 170.265 75.9207 173.258 75.9772 176.261C75.718 178.09 75.7887 179.942 75.784 181.785C61.6709 181.771 47.5579 181.78 33.4449 181.78C28.882 181.672 24.3191 182.087 19.7609 181.743C19.7467 121.171 19.775 60.5989 19.7373 0.022325ZM201.392 121.666C201.34 123.82 201.368 125.974 201.382 128.133C201.26 140.672 198.691 153.21 193.567 164.669C187.462 178.424 177.936 190.704 165.911 199.778C151.93 210.445 134.569 216.841 116.921 216.912C103.152 216.931 89.3832 216.879 75.6143 216.94C75.586 222.3 75.6284 227.659 75.5907 233.019C91.8673 232.962 108.144 233 124.421 232.991C132.052 233.184 139.717 232.265 147.084 230.233C173.062 223.016 194.712 203.087 205.441 178.523C211.503 164.269 214.406 148.511 212.804 133.049C209.033 129.222 205.116 125.54 201.392 121.666Z";

function DojoMark({ size = 46 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 250 250"
      aria-label="Dojo"
      className="dojo-mark-animated"
    >
      <path
        pathLength={1}
        d={DOJO_MARK_PATH}
        fill="#F2F1ED"
        stroke="#F2F1ED"
        strokeWidth={3}
        strokeLinejoin="miter"
      />
    </svg>
  );
}

// ── Inner Component ───────────────────────────────────────────────
function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isVerified = searchParams.get("verified") === "true";
  const isRegistered = searchParams.get("registered") === "true";
  const isReset = searchParams.get("reset") === "true";

  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw]     = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);

  // Client feedback: show a "Try again" snackbar if sign-in hangs for
  // more than 3s. The hook auto-clears the toast when `loading` flips
  // back to false so users don't see stale messages after success.
  const [timeoutMsg, setTimeoutMsg] = useTimeoutToast(
    loading,
    "Still working… try again in a moment."
  );

  // OAuth stubs — Google/Meta credentials aren't wired up yet; showing
  // a toast is more honest than fake buttons that silently do nothing.
  const [oauthToast, setOauthToast] = useState<string | null>(null);

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error: authError } = await authClient.signIn.email({
      email,
      password,
    });

    if (authError) {
      setError(authError.message ?? "Sign in failed. Please try again.");
      setLoading(false);
      return;
    }

    // Successful sign-in — redirect to dashboard
    router.push("/dashboard");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0", flex: 1 }}>
      {/* ── Mark + Heading ──
          Ported from SCREENS.signin (dojo-prototype/app.js): the mark
          appears here, inline, only on this screen — centered, above
          the heading — not as a persistent site-wide header. Copy
          matches the reference exactly ("welcome to the dojo" /
          "your collection is a portfolio."), not the previous
          "the place for collectors" line which doesn't exist there. */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "11px", marginBottom: "26px" }}>
        <DojoMark size={46} />
        <p className="dojo-heading" style={{ margin: 0, textAlign: "center" }}>welcome to the dojo</p>
        <p className="dojo-body" style={{ margin: 0, textAlign: "center" }}>your collection is a portfolio.</p>
      </div>

      {/* Success Banner */}
      {(isRegistered || isVerified || isReset) && (
        <div
          style={{
            background: "rgba(0, 168, 107, 0.12)",
            border: "1px solid #00A86B",
            padding: "12px 14px",
            marginBottom: "20px",
            display: "flex",
            alignItems: "center",
            gap: "10px",
          }}
        >
          <CheckIcon />
          <span style={{ fontSize: "13px", color: "#00A86B", fontWeight: 600 }}>
            {isRegistered
              ? "Account & profile created successfully! Please sign in to enter the Dojo."
              : isReset
              ? "Password reset successfully! Sign in with your new password."
              : "Phone number verified successfully! Sign in to continue."}
          </span>
        </div>
      )}

      {/* ── Form ── */}
      <form onSubmit={handleSignIn} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {/* Email */}
        <div className="dojo-input-wrap">
          <label htmlFor="login-email" className="dojo-label">Email</label>
          <input
            id="login-email"
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

        {/* Password — SHOW/HIDE text toggle only (client feedback: no
            more eye icon inside the input, per the design system's
            text-only visibility toggle at the top-right of the label). */}
        <div className="dojo-input-wrap">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <label htmlFor="login-password" className="dojo-label">Password</label>
            <button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              className="dojo-link"
              aria-pressed={showPw}
              suppressHydrationWarning
            >
              {showPw ? "HIDE" : "SHOW"}
            </button>
          </div>
          <input
            id="login-password"
            type={showPw ? "text" : "password"}
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={loading}
            className="dojo-input"
            suppressHydrationWarning
          />
        </div>

        {/* Forgot password — ported from app.js SCREENS.signin:
            `<span class="link" data-a="noop">Forgot password?</span>`,
            right-aligned below the password field. The reference wires
            it to a no-op; here it links to a real request-reset flow. */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "-6px" }}>
          <Link href="/forgot-password" className="dojo-link" style={{ fontSize: "9.5px" }}>
            Forgot password?
          </Link>
        </div>

        {/* Server error */}
        {error && (
          <p className="dojo-error dojo-shake" role="alert" key={error}>
            {error}
          </p>
        )}

        {/* Submit */}
        <button
          id="btn-sign-in"
          type="submit"
          disabled={loading || !email || !password}
          className="dojo-btn dojo-btn-primary"
          style={{ marginTop: "8px" }}
        >
          {loading ? "Signing in…" : (
            <>SIGN IN <ArrowRight /></>
          )}
        </button>
      </form>

      {/* ── OR divider ── */}
      <div className="dojo-divider" style={{ margin: "22px 0 18px" }}>
        <div className="dojo-divider-line" />
        <span className="dojo-divider-text">OR</span>
        <div className="dojo-divider-line" />
      </div>

      {/* OTP sign-in disabled for MVP — re-enable in Week 4 with SMS provider */}

      {/* Social buttons — OAuth providers aren't hooked up yet. Clicking
          shows a "coming in Week 4" toast per client feedback. */}
      <div style={{ display: "flex", gap: "12px" }}>
        <button
          id="btn-google"
          type="button"
          className="dojo-btn dojo-btn-outline"
          onClick={() => setOauthToast("Google login coming in Week 4")}
        >
          <GoogleIcon />
          GOOGLE
        </button>
        <button
          id="btn-facebook"
          type="button"
          className="dojo-btn dojo-btn-outline"
          onClick={() => setOauthToast("Meta login coming in Week 4")}
        >
          <FacebookIcon />
          FACEBOOK
        </button>
      </div>

      {/* ── Footer links ──
          margin-top:auto pins this to the true bottom of the screen,
          matching the reference (app.js SCREENS.signin: the footer div
          has `margin-top:auto` inside a `.form{flex:1}` container) —
          previously this was a fixed 36px gap after the buttons, which
          only looked "middle of page" whenever the form content was
          short of filling the viewport. */}
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
          new here?{" "}
          <Link href="/signup" className="dojo-link">
            Create account ›
          </Link>
        </p>
        <button type="button" className="dojo-link" style={{ fontSize: "9px", letterSpacing: "0.18em" }}>
          NEED HELP?
        </button>
      </div>

      {/* Timeout + OAuth-stub toasts (single component slot, one wins) */}
      {timeoutMsg && (
        <Toast message={timeoutMsg} onDismiss={() => setTimeoutMsg(null)} tone="error" duration={3200} />
      )}
      {oauthToast && (
        <Toast message={oauthToast} onDismiss={() => setOauthToast(null)} />
      )}
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div style={{ padding: "20px", color: "var(--color-dojo-body)" }}>Loading...</div>}>
      <LoginContent />
    </Suspense>
  );
}

