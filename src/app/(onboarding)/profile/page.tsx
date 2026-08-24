"use client";

/**
 * Screen 05 — Create Profile (Onboarding Step 2 of 3)
 *
 * Rebuilt to match dojo-prototype/app.js SCREENS.profile exactly:
 *   - Avatar (initials) + a single UPLOAD button (no "RANDOMIZE" — that
 *     button does not exist in the reference; it was a Claude Design
 *     mockup leftover, not part of the shipped prototype).
 *   - Username field, auto-filled hint.
 *   - Location field — a custom select trigger + dropdown menu of
 *     cities (was entirely missing before).
 *   - Currency — a single-tap toggle between USD/INR (the reference
 *     renders this with `.select` markup but `toggleCurrency` just
 *     flips the value directly; there's no dropdown menu for currency).
 *   - Profile visibility — a two-way segmented control (Public/Private),
 *     not a checkbox-style toggle switch (the reference's `.toggle` CSS
 *     is never instantiated by any real screen; profile visibility
 *     always uses `.seg`).
 *   - Button reads "CREATE PROFILE", not "CONTINUE".
 *
 * Action: "CREATE PROFILE" → /dashboard (via /login?registered=true).
 */

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession, authClient } from "@/lib/auth-client";

type Currency = "USD" | "INR";

const CITIES = ["Mumbai", "Delhi", "Bengaluru", "Pune", "Chennai", "Hyderabad", "Kolkata"];

function ArrowRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function LogOutIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true">
      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function initials(s: string): string {
  return String(s || "?").replace(/^@/, "").charAt(0).toUpperCase();
}

export default function CreateProfilePage() {
  const router = useRouter();
  const { data: session } = useSession();

  // Pre-fill username from session name if available
  const defaultUsername = session?.user?.name ?? "";

  const [username, setUsername]       = useState(defaultUsername);
  const [currency, setCurrency]       = useState<Currency>("USD");
  const [location, setLocation]       = useState("");
  const [locMenuOpen, setLocMenuOpen] = useState(false);
  const [isPublic, setIsPublic]       = useState(true);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [loading, setLoading]         = useState(false);
  const [loggingOut, setLoggingOut]   = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // If user profile is already completed, redirect to /dashboard
  useEffect(() => {
    if (session?.user?.name && session.user.name.length > 0) {
      const completed = typeof window !== "undefined" && localStorage.getItem(`profile_completed_${session.user.id}`);
      if (completed === "true") {
        router.replace("/dashboard");
      }
    }
  }, [session, router]);

  // ── Avatar upload ──────────────────────────────────────────
  // Ported from app.js A.failUpload: this is a scripted-failure demo
  // affordance in the reference, not a real upload — clicking UPLOAD
  // always shows the "3.4 mb is over the 2 mb cap" error. We keep a
  // real file input wired up too (so an actual upload flow keeps
  // working once a backend exists) but preserve the exact demo copy
  // when no real file has been picked.
  function handleUploadClick() {
    fileInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      setUploadError("upload failed — 3.4 mb is over the 2 mb cap. pick a smaller file.");
      return;
    }
    setUploadError(null);
  }

  // ── Location dropdown ───────────────────────────────────────
  function toggleLocMenu() {
    setLocMenuOpen((v) => !v);
  }
  function pickLocation(city: string) {
    setLocation(city);
    setLocMenuOpen(false);
  }

  // ── Currency — single-tap toggle, not a menu ────────────────
  function toggleCurrency() {
    setCurrency((c) => (c === "USD" ? "INR" : "USD"));
  }

  // ── Continue ─────────────────────────────────────────────────
  async function handleContinue(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim()) return;

    setLoading(true);

    if (session?.user?.id) {
      localStorage.setItem(`profile_completed_${session.user.id}`, "true");
    }

    // Go straight to dashboard — user is already signed in from signup.
    // No sign-out needed: the old flow signed out here only because it
    // went through the OTP step first (which was a separate session).
    window.location.href = "/dashboard";
  }

  // ── Log Out ──────────────────────────────────────────────────
  async function handleLogOut() {
    setLoggingOut(true);
    try {
      await authClient.signOut();
    } catch (err) {
      console.error("Sign out error:", err);
    } finally {
      window.location.href = "/login";
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      {/* ── Step label ── */}
      <span className="dojo-step-label" style={{ marginBottom: "10px" }}>
        Step 2 of 2
      </span>

      {/* ── Heading ── */}
      <h1 className="dojo-heading" style={{ marginBottom: "26px" }}>
        create your profile
      </h1>

      <form onSubmit={handleContinue} style={{ display: "flex", flexDirection: "column", flex: 1 }}>
        {/* ── Avatar section — matches app.js: initials avatar +
            a single UPLOAD button, no "RANDOMIZE" ── */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "12px", marginBottom: "22px" }}>
          <div
            style={{
              width: "88px",
              height: "88px",
              flex: "none",
              background: "var(--color-dojo-gold)",
              color: "#0D0D0D",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "var(--font-display)",
              fontWeight: 800,
              fontSize: "38px",
            }}
          >
            {initials(username || "kenji.dojo")}
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px" }}>
            <button
              id="btn-upload-avatar"
              type="button"
              onClick={handleUploadClick}
              className="dojo-btn dojo-btn-outline-sm"
            >
              UPLOAD
            </button>
            <p className="dojo-faint">png or jpg · under 2 mb</p>
            {uploadError && (
              <p className="dojo-error dojo-shake" role="alert" style={{ lineHeight: 1.5, textAlign: "center" }} key={uploadError}>
                {uploadError}
              </p>
            )}
          </div>
        </div>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg"
          onChange={handleFileChange}
          style={{ display: "none" }}
          aria-hidden="true"
        />

        {/* ── Username ── */}
        <div className="dojo-input-wrap" style={{ marginBottom: "6px" }}>
          <label htmlFor="profile-username" className="dojo-label">Username</label>
          <input
            id="profile-username"
            type="text"
            autoComplete="username"
            placeholder="pick a handle"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            disabled={loading || loggingOut}
            className="dojo-input"
          />
        </div>
        <p className="dojo-faint" style={{ marginBottom: "22px" }}>
          auto-filled from sign up.
        </p>

        {/* ── Location — custom select + dropdown, ported from
            app.js toggleLoc/pickLoc (this whole field was missing) ── */}
        <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: "8px", marginBottom: "22px" }}>
          <label className="dojo-label">Location</label>
          <div
            className={`dojo-select-trigger${locMenuOpen ? " open" : ""}`}
            onClick={toggleLocMenu}
          >
            <span className={`val${location ? "" : " ph"}`}>{location || "pick your city"}</span>
            <span className="chev"><ChevronDown /></span>
          </div>
          <p className="dojo-faint">buyers and sellers near you get shown first.</p>
          {locMenuOpen && (
            <div className="dojo-menu" style={{ top: "100%", marginTop: "68px" }}>
              {CITIES.map((city) => (
                <div
                  key={city}
                  className={`row${location === city ? " on" : ""}`}
                  onClick={() => pickLocation(city)}
                >
                  <span style={{ flex: 1 }}>{city}</span>
                  {location === city && <span className="mk">◆</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Currency — single-tap toggle, ported from
            app.js toggleCurrency (was a dropdown before, wrong) ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "22px" }}>
          <label className="dojo-label">Currency</label>
          <div className="dojo-select-trigger" onClick={toggleCurrency}>
            <span className="val">{currency === "USD" ? "USD — US Dollar" : "INR — Indian Rupee"}</span>
            <span className="chev"><ChevronDown /></span>
          </div>
          <p className="dojo-faint">usd and inr supported for now. tap to switch.</p>
        </div>

        {/* ── Profile visibility — segmented Public/Private control,
            ported from app.js .seg/setPub (was a checkbox toggle
            switch before, which the reference never uses for this) ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <label className="dojo-label">Profile</label>
          <div className="dojo-seg">
            <button
              type="button"
              className={isPublic ? "on" : undefined}
              onClick={() => setIsPublic(true)}
            >
              Public
            </button>
            <button
              type="button"
              className={!isPublic ? "on" : undefined}
              onClick={() => setIsPublic(false)}
            >
              Private
            </button>
          </div>
          <p className="dojo-faint" style={{ lineHeight: 1.5 }}>
            {isPublic
              ? "username, avatar and join date are public. holdings stay hidden."
              : "everything hidden except username and avatar."}
          </p>
        </div>

        {/*
          Footer block (Create Profile + Log Out) — pinned to the true
          bottom of the screen as a single unit via marginTop:"auto" on
          this wrapper (not on the segmented control above it). The
          reference (app.js SCREENS.profile) has no Log Out button at
          all — CREATE PROFILE alone sits at `margin-top:auto`. Log Out
          is a reasonable addition for a real app (users need a way out
          of onboarding), but it was previously placed as a *sibling*
          of the flex:1 <form>, after a child inside the form already
          had `marginBottom:"auto"` — that pinned CREATE PROFILE to the
          bottom edge and pushed LOG OUT below the fold, requiring an
          extra scroll. Grouping them into one bottom-pinned block fixes
          that: both buttons are now always visible together.
        */}
        <div style={{ marginTop: "auto", paddingTop: "26px", display: "flex", flexDirection: "column" }}>
          <button
            id="btn-create-profile"
            type="submit"
            disabled={loading || loggingOut || !username.trim()}
            className="dojo-btn dojo-btn-primary"
          >
            {loading ? "Setting up…" : (
              <>CREATE PROFILE <ArrowRight /></>
            )}
          </button>

          <div style={{ marginTop: "20px", borderTop: "1px solid var(--color-dojo-divider)", paddingTop: "18px", display: "flex", justifyContent: "center" }}>
            <button
              id="btn-logout"
              type="button"
              onClick={handleLogOut}
              disabled={loggingOut}
              style={{
                background: "none",
                border: "1px solid var(--color-dojo-vermilion)",
                color: "var(--color-dojo-vermilion)",
                fontFamily: "var(--font-display)",
                fontWeight: 800,
                fontSize: "11px",
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                padding: "10px 20px",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                opacity: loggingOut ? 0.6 : 1,
              }}
            >
              <LogOutIcon />
              {loggingOut ? "LOGGING OUT…" : "LOG OUT"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
