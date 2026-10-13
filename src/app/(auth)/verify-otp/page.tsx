"use client";

/**
 * Screen 04 — Verify Email (Email-OTP, Phase A)
 *
 * The user lands here after sign-up (signup/page.tsx redirects with ?email=),
 * or after an unverified credential sign-in (login/page.tsx). A 6-digit code
 * was emailed by Better Auth's `emailOTP` plugin (sendVerificationOnSignUp);
 * this screen verifies it. On success the plugin establishes a session
 * (auth.ts `emailVerification.autoSignInAfterVerification: true`), so the user
 * is logged in and we route to /profile (onboarding), which continues to
 * /search — preserving the existing registration chain.
 *
 * Client API note: the plugin id "email-otp" maps to the LOWERCASE namespace
 * `authClient.emailOtp` — `authClient.emailOTP` is undefined at runtime.
 */

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { ArrowRight } from "@/components/ArrowRight";

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-dojo-jade)" strokeWidth="2.5" strokeLinecap="square" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

const RESEND_COOLDOWN_SECONDS = 30;

function VerifyOtpContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const emailFromQuery = searchParams.get("email") ?? "";

  // When ?email= is absent (deep-link), fall back to an email input so the
  // screen is never dead.
  const [email, setEmail] = useState(emailFromQuery);
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  // Keep local email in sync if the query param resolves after mount.
  useEffect(() => {
    if (emailFromQuery) setEmail(emailFromQuery);
  }, [emailFromQuery]);

  // Resend cooldown countdown.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error: authError } = await authClient.emailOtp.verifyEmail({
      email,
      otp: code,
    });

    if (authError) {
      // Do NOT distinguish wrong vs expired vs attempts-exhausted — a single
      // generic message avoids leaking which (enumeration-safe, matching
      // forgot-password).
      setError("That code is invalid or expired. Request a new one.");
      setLoading(false);
      return;
    }

    // Verified + auto-signed-in (autoSignInAfterVerification) → onboarding.
    router.push("/profile");
  }

  async function handleResend() {
    if (cooldown > 0 || resending || !email) return;
    setResending(true);
    setError(null);
    setResent(false);

    const { error: authError } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "email-verification",
    });

    setResending(false);

    if (authError) {
      setError(authError.message ?? "Could not resend the code. Please try again.");
      return;
    }

    setResent(true);
    setCooldown(RESEND_COOLDOWN_SECONDS);
  }

  const codeComplete = /^\d{6}$/.test(code);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      {/* ── Heading ── */}
      <h1 className="dojo-heading" style={{ marginBottom: "8px" }}>verify your email</h1>
      <p className="dojo-body" style={{ marginBottom: "28px" }}>
        {email
          ? `enter the 6-digit code we sent to ${email}.`
          : "enter the email you signed up with and the 6-digit code we sent you."}
      </p>

      <form onSubmit={handleVerify} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {/* Email fallback — only when the query param is missing. */}
        {!emailFromQuery && (
          <div className="dojo-input-wrap">
            <label htmlFor="verify-email" className="dojo-label">Email</label>
            <input
              id="verify-email"
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
        )}

        {/* 6-digit code — one field, OS/browser autofills the email code. */}
        <div className="dojo-input-wrap">
          <label htmlFor="verify-code" className="dojo-label">Verification code</label>
          <input
            id="verify-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            required
            disabled={loading}
            className="dojo-input"
          />
        </div>

        {/* Resend confirmation — jade banner like forgot-password. */}
        {resent && (
          <div
            style={{
              background: "rgba(0, 168, 107, 0.12)",
              border: "1px solid var(--color-dojo-jade)",
              padding: "12px 14px",
              display: "flex",
              alignItems: "center",
              gap: "10px",
            }}
          >
            <CheckIcon />
            <span style={{ fontSize: "13px", color: "var(--color-dojo-jade)", fontWeight: 600 }}>
              A fresh code is on its way.
            </span>
          </div>
        )}

        {/* Server error */}
        {error && (
          <p className="dojo-error dojo-shake" role="alert" key={error}>
            {error}
          </p>
        )}

        {/* Submit */}
        <button
          id="btn-verify"
          type="submit"
          disabled={loading || !email || !codeComplete}
          className="dojo-btn dojo-btn-primary"
          style={{ marginTop: "8px" }}
        >
          {loading ? "Verifying…" : (
            <>VERIFY <ArrowRight /></>
          )}
        </button>

        {/* Resend */}
        <button
          type="button"
          onClick={handleResend}
          disabled={resending || cooldown > 0 || !email}
          className="dojo-link"
          style={{ alignSelf: "center", fontSize: "11px", letterSpacing: "0.08em", marginTop: "4px" }}
        >
          {resending
            ? "Resending…"
            : cooldown > 0
            ? `Resend code in ${cooldown}s`
            : "Resend code"}
        </button>
      </form>

      {/* ── Footer ── margin-top:auto pins to the true bottom of the screen
          (same pattern as login/signup/forgot-password). */}
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
        <button type="button" className="dojo-link" style={{ fontSize: "9px", letterSpacing: "0.18em" }}>
          NEED HELP?
        </button>
      </div>
    </div>
  );
}

export default function VerifyOtpPage() {
  return (
    <Suspense fallback={<div style={{ padding: "20px", color: "var(--color-dojo-body)" }}>Loading...</div>}>
      <VerifyOtpContent />
    </Suspense>
  );
}
