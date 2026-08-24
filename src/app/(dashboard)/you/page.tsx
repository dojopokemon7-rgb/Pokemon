"use client";

/**
 * Screen 08 — Account (/you)
 *
 * Rebuilt to match dojo-prototype/app.js SCREENS.account exactly
 * (previously an approximation with different sections/labels):
 *   - Avatar + @handle + "joined a month ago" + tag chips + settings icon.
 *   - 3-col stat grid (Cards / Sealed / Graded) — ACC_TOTALS in the reference.
 *   - 2-col stat grid (Total paid / Total value) — ACC_PAID / ACC_VALUE.
 *   - "Visibility" section: per-collection Public/Private segmented
 *     toggle (ported from app.js setVis — S.vis[key]).
 *   - "Connected accounts": Google / Meta rows with a Disconnect link.
 *   - CONTACT SUPPORT outline button + "Log out" link.
 *
 * The reference's numbers (ACC_TOTALS/ACC_PAID/ACC_VALUE) are fixed
 * mock data in a static demo — this keeps the same layout and mock
 * values, since there's no live stats endpoint yet, while still using
 * the real Better Auth session for the identity (avatar initials,
 * handle, verified status) the way the previous version already did.
 */

import { useState } from "react";
import { useSession, authClient } from "@/lib/auth-client";

// ── Icons ──────────────────────────────────────────────────────────
function SettingsIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008.7 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H2a2 2 0 110-4h.09A1.65 1.65 0 003.6 8.7a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H8a1.65 1.65 0 001-1.51V2a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V8a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
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

// ── Mock account totals — ported verbatim from data.js
// ACC_TOTALS / ACC_PAID / ACC_VALUE (fixed demo numbers; no live
// stats endpoint exists yet). ───────────────────────────────────────
const ACC_TOTALS = [
  { label: "Cards", value: "74" },
  { label: "Sealed", value: "22" },
  { label: "Graded", value: "6" },
];
const ACC_PAID = 9230;
const ACC_VALUE = 28682.05;

function fmtUSD(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function initials(name: string): string {
  return String(name || "?").replace(/^@/, "").charAt(0).toUpperCase();
}

export default function YouAccountPage() {
  const { data: session, isPending } = useSession();
  const [loggingOut, setLoggingOut] = useState(false);
  // Per-collection visibility — ported from app.js S.vis (defaults to
  // true/"Public", matching freshState()'s { coll1: true, coll2: false }).
  const [vis, setVis] = useState<Record<string, boolean>>({ coll1: true, coll2: false });
  const [connected, setConnected] = useState<Record<string, boolean>>({ Google: true, Meta: true });

  const user = session?.user;
  const handle = "@" + (user?.name?.toLowerCase().replace(/\s+/g, ".") ?? "kenji.dojo");

  async function handleLogOut() {
    setLoggingOut(true);
    try {
      await authClient.signOut();
    } catch (err) {
      console.error("Logout error:", err);
    } finally {
      window.location.href = "/login";
    }
  }

  if (isPending) {
    return (
      <div style={{ padding: "24px 22px", color: "var(--color-dojo-body)" }}>
        Loading account…
      </div>
    );
  }

  const VIS_ROWS: [string, string][] = [
    ["collection 1", "coll1"],
    ["collection 2", "coll2"],
  ];

  return (
    <div style={{ padding: "6px 22px 24px" }}>
      {/* ── Profile header ── */}
      <div style={{ display: "flex", gap: "15px", alignItems: "center", marginTop: "16px" }}>
        <div
          style={{
            width: "62px", height: "62px", flex: "none",
            background: "var(--color-dojo-raised)", border: "1px solid var(--color-dojo-stroke)",
            display: "flex", alignItems: "center", justifyContent: "center",
            overflow: "hidden",
          }}
        >
          {user?.image ? (
            <img src={user.image} alt={user.name ?? "Avatar"} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "22px", color: "var(--color-dojo-gold)" }}>
              {initials(user?.name ?? "kenji.dojo")}
            </span>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "16px", color: "var(--color-dojo-ink)" }}>
            {handle}
          </div>
          <div style={{ marginTop: "3px", fontSize: "11.5px", color: "var(--color-dojo-body)" }}>
            joined a month ago
          </div>
          <div style={{ display: "flex", gap: "8px", marginTop: "8px", flexWrap: "wrap" }}>
            <span className="dojo-tag acc">Collector</span>
            <span className="dojo-tag">◆ First grade badge</span>
          </div>
        </div>
        <span style={{ alignSelf: "flex-start", color: "var(--color-dojo-body)", display: "flex" }}>
          <SettingsIcon />
        </span>
      </div>

      {/* ── Stat grids ── */}
      <div className="dojo-statgrid" style={{ marginTop: "22px" }}>
        {ACC_TOTALS.map((t) => (
          <div key={t.label} className="cell">
            <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
              {t.label}
            </div>
            <div style={{ marginTop: "6px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "15px", fontVariantNumeric: "tabular-nums", color: "var(--color-dojo-ink)" }}>
              {t.value}
            </div>
          </div>
        ))}
      </div>
      <div className="dojo-statgrid two">
        <div className="cell" style={{ textAlign: "left" }}>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
            Total paid
          </div>
          <div style={{ marginTop: "6px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "18px", fontVariantNumeric: "tabular-nums", color: "var(--color-dojo-ink)" }}>
            {fmtUSD(ACC_PAID)}
          </div>
        </div>
        <div className="cell" style={{ textAlign: "left" }}>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
            Total value
          </div>
          <div style={{ marginTop: "6px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "18px", fontVariantNumeric: "tabular-nums", color: "var(--color-dojo-ink)" }}>
            {fmtUSD(ACC_VALUE)}
          </div>
        </div>
      </div>

      {/* ── Visibility ── */}
      <div style={{ marginTop: "24px", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
        Visibility
      </div>
      <p className="dojo-body" style={{ marginTop: "4px" }}>who can see each collection on your profile.</p>
      {VIS_ROWS.map(([label, key]) => {
        const on = vis[key] !== false;
        return (
          <div key={key} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "13px 0", borderBottom: "1px solid var(--color-dojo-divider)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13.5px", color: "var(--color-dojo-ink)" }}>{label}</div>
              <div style={{ marginTop: "3px", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "8.5px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-faint)" }}>
                {on ? "visible to everyone" : "only you"}
              </div>
            </div>
            <div className="dojo-seg-tight">
              <button type="button" className={on ? "on" : undefined} onClick={() => setVis((s) => ({ ...s, [key]: true }))}>
                Public
              </button>
              <button type="button" className={!on ? "on" : undefined} onClick={() => setVis((s) => ({ ...s, [key]: false }))}>
                Private
              </button>
            </div>
          </div>
        );
      })}

      {/* ── Connected accounts ── */}
      <div style={{ marginTop: "22px", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
        Connected accounts
      </div>
      {(["Google", "Meta"] as const).map((n) => (
        <div key={n} style={{ display: "flex", alignItems: "center", padding: "13px 0", borderBottom: "1px solid var(--color-dojo-divider)" }}>
          <div style={{ flex: 1, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "13px", color: "var(--color-dojo-ink)" }}>
            {n}
          </div>
          {connected[n] ? (
            <button
              onClick={() => setConnected((s) => ({ ...s, [n]: false }))}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-vermilion)" }}
            >
              Disconnect
            </button>
          ) : (
            <button
              onClick={() => setConnected((s) => ({ ...s, [n]: true }))}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-dojo-gold)" }}
            >
              Connect
            </button>
          )}
        </div>
      ))}

      {/* ── Contact support + Log out ── */}
      <div style={{ margin: "22px 0 6px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <button type="button" className="dojo-btn dojo-btn-outline" style={{ height: "44px" }}>
          CONTACT SUPPORT
        </button>
        <button
          id="btn-account-logout"
          type="button"
          onClick={handleLogOut}
          disabled={loggingOut}
          style={{
            background: "none",
            border: "none",
            color: "var(--color-dojo-vermilion)",
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: "11px",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            padding: "10px",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
            opacity: loggingOut ? 0.6 : 1,
          }}
        >
          <LogOutIcon />
          {loggingOut ? "LOGGING OUT…" : "Log out"}
        </button>
      </div>
    </div>
  );
}
