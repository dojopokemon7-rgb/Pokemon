"use client";

/**
 * Card Scanner Placeholder Page (/scanner)
 */

import { useRouter } from "next/navigation";

export default function ScannerPage() {
  const router = useRouter();

  return (
    <div style={{ padding: "24px 22px", color: "var(--color-dojo-ink)" }}>
      <button
        onClick={() => router.back()}
        style={{
          background: "none",
          border: "none",
          color: "var(--color-dojo-gold)",
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: "12px",
          cursor: "pointer",
          marginBottom: "20px",
        }}
      >
        ‹ Back
      </button>

      <h1 className="dojo-heading" style={{ fontSize: "24px", marginBottom: "8px" }}>
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
