"use client";

/**
 * Card Scanner (/scanner) — F-14 MVP.
 *
 * Flow: live camera preview → "Scan" → POST /api/cards/recognize →
 * render the matched card + an "Add to Collection" action.
 *
 * The recognition backend is currently a mock (returns a fixed Charizard
 * match); the capture here sends a placeholder identifier rather than a
 * real frame grab. When a real Vision API is wired in, only the capture
 * payload and the API internals change — this component's structure stays.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface RecognizedCard {
  id: string;
  name: string;
  set: string;
  imageUrl: string;
}

export default function ScannerPage() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [result, setResult] = useState<RecognizedCard | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Distinct from `error`: when the camera is denied there's nothing to
  // scan, so we swap the Scan control for an "Enable Camera" retry.
  const [cameraDenied, setCameraDenied] = useState(false);

  // Requests the camera and attaches the stream to the <video>. Callable
  // again from "Enable Camera" so a denial is recoverable without reload.
  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setCameraDenied(false);
    } catch {
      setCameraDenied(true);
    }
  }, []);

  useEffect(() => {
    startCamera();
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [startCamera]);

  async function handleScan() {
    setScanning(true);
    setError(null);
    try {
      // MVP: send a placeholder identifier. A real capture would grab a
      // frame from the video into a canvas and send its base64 data URL.
      const res = await fetch("/api/cards/recognize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: "mock-capture" }),
      });

      // Non-2xx (e.g. 500) → generic error, don't try to trust the body.
      if (!res.ok) {
        setResult(null);
        setError("Scanner error, please try again.");
        return;
      }

      const data = await res.json().catch(() => null);
      if (data?.success && data.card) {
        setResult(data.card as RecognizedCard);
      } else {
        // Recognized-nothing: surface the API message when present, else
        // the default not-recognized copy. Scan button stays for a retry.
        setResult(null);
        setError(
          typeof data?.message === "string" ? data.message : "Card not recognized."
        );
      }
    } catch {
      setError("Scanner error, please try again.");
    } finally {
      setScanning(false);
    }
  }

  return (
    <div
      style={{
        position: "relative",
        /* Locked to the viewport height — the scanner is an immersive
           camera view rendered full-bleed by the shell (no header/nav),
           so the viewfinder can never scroll (Defect 5). */
        height: "100dvh",
        overflow: "hidden",
        padding: "24px 22px",
        color: "var(--color-dojo-ink)",
        display: "flex",
        flexDirection: "column",
        gap: "16px",
      }}
    >
      <button
        onClick={() => router.back()}
        aria-label="Close"
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

      <h1 className="dojo-heading" style={{ fontSize: "24px", margin: 0, paddingRight: "48px" }}>
        Card Scanner
      </h1>
      <p style={{ color: "var(--color-dojo-body)", fontSize: "14px", margin: 0 }}>
        Point your camera at a card, then tap Scan.
      </p>

      <video
        ref={videoRef}
        data-testid="camera-preview"
        autoPlay
        muted
        playsInline
        style={{
          width: "100%",
          maxHeight: "320px",
          background: "#000",
          border: "1px solid var(--color-dojo-stroke)",
          objectFit: "cover",
        }}
      />

      {cameraDenied ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <p style={{ color: "var(--color-dojo-body)", fontSize: "13px", margin: 0 }}>
            Camera access denied. Allow camera access to scan a card.
          </p>
          <button
            onClick={startCamera}
            style={{
              padding: "12px 20px",
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              background: "var(--color-dojo-gold)",
              color: "var(--color-dojo-app)",
              border: "1px solid var(--color-dojo-stroke)",
              cursor: "pointer",
              alignSelf: "flex-start",
            }}
          >
            Enable Camera
          </button>
        </div>
      ) : (
        <button
          onClick={handleScan}
          disabled={scanning}
          style={{
            padding: "12px 20px",
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            background: "var(--color-dojo-gold)",
            color: "var(--color-dojo-app)",
            border: "1px solid var(--color-dojo-stroke)",
            cursor: scanning ? "default" : "pointer",
          }}
        >
          {scanning ? "Scanning…" : "Scan"}
        </button>
      )}

      {error && (
        <p role="alert" style={{ color: "var(--color-dojo-body)", fontSize: "13px", margin: 0 }}>{error}</p>
      )}

      {result && (
        <div
          style={{
            background: "var(--color-dojo-card)",
            border: "1px solid var(--color-dojo-stroke)",
            padding: "16px",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <p style={{ margin: 0, fontWeight: 700 }}>{result.name}</p>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--color-dojo-body)" }}>{result.set}</p>
          <button
            style={{
              padding: "10px 16px",
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              background: "var(--color-dojo-ink)",
              color: "#fff",
              border: "1px solid var(--color-dojo-stroke)",
              cursor: "pointer",
            }}
          >
            Add to Collection
          </button>
        </div>
      )}
    </div>
  );
}
