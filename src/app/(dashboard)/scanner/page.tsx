"use client";

/**
 * Card Scanner Placeholder Page (/scanner)
 */

import { useRouter } from "next/navigation";

export default function ScannerPage() {
  const router = useRouter();

  return (
    // Scanner is a fixed, non-scrolling viewport — it previews the
    // eventual full-screen camera view, so it must never scroll
    // (Phase 3 QA: overflow-hidden, not scrollable).
    <div
      style={{
        position: "relative",
        height: "100%",
        minHeight: "100%",
        overflow: "hidden",
        padding: "24px 22px",
        color: "var(--color-dojo-ink)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Close (X) — replaces the old "‹ Back" text control (Phase 3 QA).
          Sits top-right like a modal dismiss; still calls router.back(). */}
      <button
        onClick={() => router.back()}
        aria-label="Close scanner"
        title="Close"
        style={{
          position: "absolute",
          top: "18px",
          right: "22px",
          zIndex: 2,
          width: "38px",
          height: "38px",
          border: "1px solid var(--color-dojo-stroke)",
          background: "var(--color-dojo-card)",
          color: "var(--color-dojo-ink)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
          <line x1="3" y1="3" x2="15" y2="15" />
          <line x1="15" y1="3" x2="3" y2="15" />
        </svg>
      </button>

      <h1 className="dojo-heading" style={{ fontSize: "24px", marginBottom: "8px", paddingRight: "48px" }}>
        Card Scanner
      </h1>
      <p style={{ color: "var(--color-dojo-body)", fontSize: "14px", marginBottom: "24px" }}>
        Instant AI & OCR card recognition using your camera.
      </p>

      <div
        style={{
          background: "var(--color-dojo-card)",
          border: "1px solid var(--color-dojo-stroke)",
          padding: "48px 20px",
          textAlign: "center",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "24px",
        }}
      >
        {/*
          Scan frame with sweeping line — ported verbatim from the
          reference's .scanframe/.sweep (dojo-prototype/styles.css),
          used here to preview the eventual camera viewport.
        */}
        <div className="dojo-scanframe">
          <i className="dojo-corner tl" />
          <i className="dojo-corner tr" />
          <i className="dojo-corner bl" />
          <i className="dojo-corner br" />
          <i className="dojo-sweep" />
        </div>

        <div
          style={{
            width: "64px",
            height: "64px",
            background: "var(--color-dojo-gold)",
            boxShadow: "4px 4px 0 0 #806A17",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#0D0D0D",
          }}
        >
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
            <path d="M3 7V5a2 2 0 012-2h2" />
            <path d="M17 3h2a2 2 0 012 2v2" />
            <path d="M21 17v2a2 2 0 01-2 2h-2" />
            <path d="M7 21H5a2 2 0 01-2-2v-2" />
            <line x1="3" y1="12" x2="21" y2="12" />
          </svg>
        </div>

        <p
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: "14px",
            color: "var(--color-dojo-ink)",
            margin: 0,
          }}
        >
          Camera OCR & Visual Search coming in Week 2
        </p>
      </div>
    </div>
  );
}
