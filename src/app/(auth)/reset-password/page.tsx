"use client";

/**
 * Reset Password — Set a New Password
 *
 * Landing page for the link sent by sendResetPassword (src/lib/auth.ts).
 * Better Auth appends a `token` query param to the redirectTo URL
 * configured in forgetPassword() (see forgot-password/page.tsx:
 * redirectTo: "/reset-password").
 *
 * Calls: authClient.resetPassword({ newPassword, token })
 */

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";

function ArrowRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" />
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

// Same 8+ chars / 1+ number rule used on signup — kept consistent.
function validatePassword(pw: string): string | null {
  if (pw.length < 8) return "eight characters minimum, at least one number.";
  if (!/\d/.test(pw)) return "eight characters minimum, at least one number.";
  return null;
}

function ResetPasswordContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [password, setPassword]   = useState("");
  const [password2, setPassword2] = useState("");
  const [showPw, setShowPw]       = useState(false);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);

  const pwHint = password.length > 0 ? validatePassword(password) : null;
  const pwOk = password.length >= 8 && /\d/.test(password);
  const pwMismatch = password2.length > 0 && password2 !== password;
  const passwordsValid = password2.length > 0 && password2 === password && pwOk;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) {
      setError("This reset link is invalid or has expired. Request a new one.");
      return;
    }

    setLoading(true);
    setError(null);

    const { error: authError } = await authClient.resetPassword({
      newPassword: password,
      token,
    });

    if (authError) {
      setError(authError.message ?? "Could not reset password. The link may have expired.");
      setLoading(false);
      return;
    }

    router.push("/login?reset=true");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      {/* ── Heading ── */}
      <h1 className="dojo-heading" style={{ marginBottom: "8px" }}>set a new password</h1>
      <p className="dojo-body" style={{ marginBottom: "28px" }}>
        choose a new password for your account.
      </p>

      {!token && (
        <p className="dojo-error" role="alert" style={{ marginBottom: "20px" }}>
          This reset link is invalid or has expired.{" "}
          <Link href="/forgot-password" className="dojo-link" style={{ fontSize: "11px" }}>
            Request a new one ›
          </Link>
        </p>
      )}

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div className="dojo-input-wrap">
          <label htmlFor="reset-password" className="dojo-label">New password</label>
          <div style={{ position: "relative" }}>
            <input
              id="reset-password"
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
                position: "absolute", right: "14px", top: "50%", transform: "translateY(-50%)",
                background: "none", border: "none", cursor: "pointer", color: "var(--color-dojo-faint)",
                padding: "4px", display: "flex", alignItems: "center",
              }}
            >
              <EyeIcon off={showPw} />
            </button>
          </div>
          <p className={pwHint ? "dojo-error" : "dojo-faint"} style={{ marginTop: "2px" }}>
            eight characters minimum, at least one number.
          </p>
        </div>

        <div className="dojo-input-wrap">
          <label htmlFor="reset-password2" className="dojo-label">Confirm new password</label>
          <input
            id="reset-password2"
            type={showPw ? "text" : "password"}
            autoComplete="new-password"
            placeholder="type it again"
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
            required
            disabled={loading}
            className="dojo-input"
          />
          {pwMismatch && (
            <p className="dojo-error" style={{ marginTop: "2px" }}>passwords don&apos;t match.</p>
          )}
        </div>

        {error && (
          <p className="dojo-error dojo-shake" role="alert" key={error}>
            {error}
          </p>
        )}

        <button
          id="btn-reset-password"
          type="submit"
          disabled={loading || !token || !passwordsValid}
          className="dojo-btn dojo-btn-primary"
          style={{ marginTop: "8px" }}
        >
          {loading ? "Resetting…" : (
            <>RESET PASSWORD <ArrowRight /></>
          )}
        </button>
      </form>

      <div style={{ marginTop: "auto", paddingTop: "26px", display: "flex", justifyContent: "center" }}>
        <Link href="/login" className="dojo-link" style={{ fontSize: "9.5px" }}>
          Back to sign in ›
        </Link>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div style={{ padding: "20px", color: "var(--color-dojo-body)" }}>Loading...</div>}>
      <ResetPasswordContent />
    </Suspense>
  );
}
