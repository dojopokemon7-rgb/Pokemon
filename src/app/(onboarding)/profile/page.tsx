"use client";

/**
 * Screen 05 — Create Profile
 *
 * Client feedback changes (Phase 1):
 *   - Removed "Step 2 of 2" label (client asked to remove step indicator)
 *   - Removed Log Out button (only appears on /you page now)
 *   - Image upload now shows a live preview of the selected image
 *   - Location dropdown expanded to 15 major world cities
 *   - Currency is a real dropdown menu with USD/INR options (not a toggle)
 *   - After profile creation → redirects to /search (not /dashboard) so
 *     the user immediately lands on the card-picking flow
 *   - Dynamic file-size error (shows actual MB, not hardcoded "3.4 mb")
 */

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";

type Currency = "USD" | "INR";

// 15 major world cities — Indian + international per client feedback
const CITIES = [
  "Mumbai",
  "Delhi",
  "Bengaluru",
  "Pune",
  "Chennai",
  "Hyderabad",
  "Kolkata",
  "New York",
  "Los Angeles",
  "London",
  "Tokyo",
  "Singapore",
  "Sydney",
  "Toronto",
  "Dubai",
];

const CURRENCIES: { code: Currency; label: string }[] = [
  { code: "USD", label: "USD — US Dollar" },
  { code: "INR", label: "INR — Indian Rupee" },
];

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

function initials(s: string): string {
  return String(s || "?").replace(/^@/, "").charAt(0).toUpperCase();
}

export default function CreateProfilePage() {
  const router = useRouter();
  const { data: session } = useSession();

  const defaultUsername = session?.user?.name ?? "";

  const [username, setUsername]         = useState(defaultUsername);
  const [currency, setCurrency]         = useState<Currency>("USD");
  const [currencyMenuOpen, setCurrMenu] = useState(false);
  const [location, setLocation]         = useState("");
  const [locMenuOpen, setLocMenuOpen]   = useState(false);
  const [isPublic, setIsPublic]         = useState(true);
  const [uploadError, setUploadError]   = useState<string | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [loading, setLoading]           = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // If profile is already completed, skip to dashboard
  useEffect(() => {
    if (session?.user?.id) {
      const completed = typeof window !== "undefined" && localStorage.getItem(`profile_completed_${session.user.id}`);
      if (completed === "true") {
        router.replace("/dashboard");
      }
    }
  }, [session, router]);

  // ── Avatar upload with live preview ────────────────────────
  function handleUploadClick() {
    fileInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const MAX_BYTES = 2 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      const mb = (file.size / 1024 / 1024).toFixed(1);
      setUploadError(`upload failed — ${mb} mb is over the 2 mb cap. pick a smaller file.`);
      // Reset input so re-picking the same file will fire onChange again
      e.target.value = "";
      return;
    }

    // Read as data URL for local preview (no backend upload yet)
    const reader = new FileReader();
    reader.onload = () => {
      setAvatarPreview(typeof reader.result === "string" ? reader.result : null);
      setUploadError(null);
    };
    reader.onerror = () => {
      setUploadError("could not read that file. try another one.");
    };
    reader.readAsDataURL(file);
  }

  // ── Dropdown helpers ────────────────────────────────────────
  function pickLocation(city: string) {
    setLocation(city);
    setLocMenuOpen(false);
  }

  function pickCurrency(c: Currency) {
    setCurrency(c);
    setCurrMenu(false);
  }

  // ── Submit — go straight to /search per client feedback ─────
  async function handleContinue(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim()) return;

    setLoading(true);

    if (session?.user?.id) {
      localStorage.setItem(`profile_completed_${session.user.id}`, "true");
    }

    // Redirect to /search so the user immediately starts picking cards.
    window.location.href = "/search";
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
      {/* ── Heading (no step label per client feedback) ── */}
      <h1 className="dojo-heading" style={{ marginBottom: "26px" }}>
        create your profile
      </h1>

      <form onSubmit={handleContinue} style={{ display: "flex", flexDirection: "column", flex: 1 }}>
        {/* ── Avatar with live preview ── */}
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
              overflow: "hidden",
            }}
          >
            {avatarPreview ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={avatarPreview}
                alt="avatar preview"
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            ) : (
              initials(username || "kenji.dojo")
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "8px" }}>
            <button
              id="btn-upload-avatar"
              type="button"
              onClick={handleUploadClick}
              className="dojo-btn dojo-btn-outline-sm"
            >
              {avatarPreview ? "CHANGE" : "UPLOAD"}
            </button>
            <p className="dojo-faint">png or jpg · under 2 mb</p>
            {uploadError && (
              <p className="dojo-error dojo-shake" role="alert" style={{ lineHeight: 1.5, textAlign: "center" }} key={uploadError}>
                {uploadError}
              </p>
            )}
          </div>
        </div>

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
            disabled={loading}
            className="dojo-input"
          />
        </div>
        <p className="dojo-faint" style={{ marginBottom: "22px" }}>
          auto-filled from sign up.
        </p>

        {/* ── Location — 15 world cities ── */}
        <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: "8px", marginBottom: "22px" }}>
          <label className="dojo-label">Location</label>
          <div
            className={`dojo-select-trigger${locMenuOpen ? " open" : ""}`}
            onClick={() => { setLocMenuOpen((v) => !v); setCurrMenu(false); }}
          >
            <span className={`val${location ? "" : " ph"}`}>{location || "pick your city"}</span>
            <span className="chev"><ChevronDown /></span>
          </div>
          <p className="dojo-faint">buyers and sellers near you get shown first.</p>
          {locMenuOpen && (
            <div className="dojo-menu" style={{ top: "100%", marginTop: "68px", maxHeight: "260px", overflowY: "auto" }}>
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

        {/* ── Currency — real dropdown menu with USD + INR ── */}
        <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: "8px", marginBottom: "22px" }}>
          <label className="dojo-label">Currency</label>
          <div
            className={`dojo-select-trigger${currencyMenuOpen ? " open" : ""}`}
            onClick={() => { setCurrMenu((v) => !v); setLocMenuOpen(false); }}
          >
            <span className="val">
              {CURRENCIES.find((c) => c.code === currency)?.label}
            </span>
            <span className="chev"><ChevronDown /></span>
          </div>
          <p className="dojo-faint">usd and inr supported for now.</p>
          {currencyMenuOpen && (
            <div className="dojo-menu" style={{ top: "100%", marginTop: "68px" }}>
              {CURRENCIES.map((c) => (
                <div
                  key={c.code}
                  className={`row${currency === c.code ? " on" : ""}`}
                  onClick={() => pickCurrency(c.code)}
                >
                  <span style={{ flex: 1 }}>{c.label}</span>
                  {currency === c.code && <span className="mk">◆</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Profile visibility ── */}
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

        {/* ── Submit button (Log Out removed per client feedback) ── */}
        <div style={{ marginTop: "auto", paddingTop: "26px" }}>
          <button
            id="btn-create-profile"
            type="submit"
            disabled={loading || !username.trim()}
            className="dojo-btn dojo-btn-primary"
          >
            {loading ? "Setting up…" : (
              <>CREATE PROFILE <ArrowRight /></>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
