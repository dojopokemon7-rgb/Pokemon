"use client";

/**
 * Card Scanner (/scanner) — F-14.
 *
 * Flow: rear-camera live preview → "Scan" captures a frame → preprocess on a
 * canvas (crop to card area, grayscale, contrast) → tesseract.js OCR extracts
 * text → POST the text to /api/cards/recognize, which fuzzy-matches real
 * catalog names → show the TOP 3 candidates ("Is this your card?"). The user
 * taps the right one to add it. No hardcoded results; low-confidence / no
 * match shows "Card not recognized" with a manual search fallback.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Candidate {
  id: string;
  name: string;
  set: string;
  imageUrl: string;
  confidence: number;
}

type Phase = "scan" | "recognizing" | "confirm" | "not-recognized";

// Product threshold: below this the top match isn't trusted (Task 2 §4).
const CONFIDENCE_THRESHOLD = 0.4;

export default function ScannerPage() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [phase, setPhase] = useState<Phase>("scan");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cameraDenied, setCameraDenied] = useState(false);
  const [added, setAdded] = useState<string | null>(null);

  // Manual search fallback state.
  const [manualQuery, setManualQuery] = useState("");
  const [manualResults, setManualResults] = useState<Candidate[]>([]);

  // Requests the REAR camera and attaches the stream to the <video>.
  // Prefers a rear-facing device by deviceId when enumerable, else uses the
  // `environment` facingMode hint, else falls back to any camera (desktop).
  const startCamera = useCallback(async () => {
    try {
      let stream: MediaStream;
      try {
        // Try to explicitly pick a rear videoinput device when the browser
        // exposes device labels/facing info.
        let rearDeviceId: string | undefined;
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const cams = devices.filter((d) => d.kind === "videoinput");
          const rear = cams.find((d) => /back|rear|environment/i.test(d.label));
          rearDeviceId = rear?.deviceId || undefined;
        } catch {
          /* enumerateDevices may be unavailable/blocked — ignore */
        }

        stream = await navigator.mediaDevices.getUserMedia({
          video: rearDeviceId
            ? { deviceId: { exact: rearDeviceId }, facingMode: { ideal: "environment" } }
            : { facingMode: { ideal: "environment" } },
        });
      } catch {
        // Desktop / no rear camera → fall back to any available camera.
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
      }

      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
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

  /** Capture the current frame, preprocess it, and return grayscale image data
   *  as a canvas the OCR engine can read. Crops to the centre card area. */
  function captureProcessedCanvas(): HTMLCanvasElement | null {
    const video = videoRef.current;
    if (!video) return null;
    // Some environments report 0 dimensions until the first frame decodes
    // (and headless/synthetic streams may never report real ones). Fall
    // back to a small canvas so the pipeline still runs — OCR simply reads
    // whatever is there (in tests OCR is injected, so this is harmless).
    const vw = video.videoWidth || 320;
    const vh = video.videoHeight || 320;
    // Crop to the centre ~70% (the card area the viewfinder frames).
    const cropW = Math.round(vw * 0.7);
    const cropH = Math.round(vh * 0.7);
    const sx = Math.round((vw - cropW) / 2);
    const sy = Math.round((vh - cropH) / 2);

    const canvas = document.createElement("canvas");
    canvas.width = cropW;
    canvas.height = cropH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // Best-effort frame grab: a not-yet-ready / synthetic video source can
    // throw here — don't let that abort the (possibly injected) OCR step.
    try {
      ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, cropW, cropH);
    } catch {
      /* proceed with a blank canvas */
    }

    // Grayscale + contrast boost so OCR reads the card name cleanly.
    const img = ctx.getImageData(0, 0, cropW, cropH);
    const d = img.data;
    const contrast = 1.4; // >1 increases contrast
    const intercept = 128 * (1 - contrast);
    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const v = Math.max(0, Math.min(255, contrast * gray + intercept));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  async function runOcr(canvas: HTMLCanvasElement): Promise<string> {
    // Test seam: E2E can inject OCR output via window.__mockOcrText so the
    // heavy tesseract.js WASM engine never has to run in the harness. In
    // production this is undefined and real OCR runs.
    const injected = (window as unknown as { __mockOcrText?: string }).__mockOcrText;
    if (typeof injected === "string") return injected.trim();

    // Dynamic import: tesseract.js is heavy and browser-only.
    const { recognize } = await import("tesseract.js");
    const { data } = await recognize(canvas, "eng");
    return (data.text ?? "").trim();
  }

  async function matchText(text: string): Promise<Candidate[]> {
    const res = await fetch("/api/cards/recognize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error("recognize failed");
    const data = await res.json().catch(() => null);
    return (data?.candidates ?? []) as Candidate[];
  }

  async function handleScan() {
    setError(null);
    setPhase("recognizing");
    try {
      const canvas = captureProcessedCanvas();
      if (!canvas) {
        setError("Couldn't capture a frame. Try again.");
        setPhase("scan");
        return;
      }
      const text = await runOcr(canvas);
      const found = await matchText(text);
      const top = found[0];
      if (!top || top.confidence < CONFIDENCE_THRESHOLD) {
        setCandidates([]);
        setPhase("not-recognized");
        return;
      }
      setCandidates(found);
      setPhase("confirm");
    } catch {
      setError("Scanner error, please try again.");
      setPhase("scan");
    }
  }

  async function addCard(c: Candidate) {
    try {
      const payload: Record<string, unknown> = {
        externalId: c.id,
        name: c.name,
        setName: c.set || undefined,
        quantity: 1,
        isFoil: false,
      };
      if (c.imageUrl && c.imageUrl.startsWith("http")) payload.imageUrl = c.imageUrl;
      const res = await fetch("/api/users/me/collection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cards: [payload] }),
      });
      if (!res.ok) throw new Error("add failed");
      setAdded(`Added ${c.name} to your portfolio`);
    } catch {
      setError("Could not add this card. Try again.");
    }
  }

  async function runManualSearch(q: string) {
    setManualQuery(q);
    const query = q.trim();
    if (query.length < 2) {
      setManualResults([]);
      return;
    }
    try {
      const res = await fetch(`/api/cards/search?game=pokemon&query=${encodeURIComponent(query)}`);
      if (!res.ok) {
        setManualResults([]);
        return;
      }
      const data = await res.json().catch(() => null);
      const cards = (data?.cards ?? []) as { id: string; name: string; setImage?: string; imageUrl?: string }[];
      setManualResults(
        cards.slice(0, 5).map((c) => ({
          id: c.id,
          name: c.name,
          set: c.setImage ?? "",
          imageUrl: c.imageUrl ?? "",
          confidence: 1,
        }))
      );
    } catch {
      setManualResults([]);
    }
  }

  function resetToScan() {
    setCandidates([]);
    setManualResults([]);
    setManualQuery("");
    setError(null);
    setAdded(null);
    setPhase("scan");
  }

  const goldBtn: React.CSSProperties = {
    padding: "12px 20px", fontFamily: "var(--font-display)", fontWeight: 700,
    background: "var(--color-dojo-gold)", color: "var(--color-dojo-app)",
    border: "1px solid var(--color-dojo-stroke)", cursor: "pointer",
  };

  return (
    <div
      style={{
        position: "relative", height: "100dvh", overflow: "hidden",
        padding: "24px 22px", color: "var(--color-dojo-ink)",
        display: "flex", flexDirection: "column", gap: "16px",
      }}
    >
      <button
        onClick={() => router.back()}
        aria-label="Close"
        title="Close"
        style={{ position: "absolute", top: "18px", right: "22px", zIndex: 2, width: "38px", height: "38px", border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)", color: "var(--color-dojo-ink)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
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
        style={{ width: "100%", maxHeight: "320px", background: "#000", border: "1px solid var(--color-dojo-stroke)", objectFit: "cover" }}
      />

      {cameraDenied ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <p style={{ color: "var(--color-dojo-body)", fontSize: "13px", margin: 0 }}>
            Camera access denied. Allow camera access to scan a card.
          </p>
          <button onClick={startCamera} style={{ ...goldBtn, alignSelf: "flex-start" }}>
            Enable Camera
          </button>
        </div>
      ) : phase === "scan" ? (
        <button onClick={handleScan} style={goldBtn}>Scan</button>
      ) : phase === "recognizing" ? (
        <button disabled style={{ ...goldBtn, cursor: "default", opacity: 0.7 }}>Scanning…</button>
      ) : null}

      {error && (
        <p role="alert" style={{ color: "var(--color-dojo-body)", fontSize: "13px", margin: 0 }}>{error}</p>
      )}
      {added && (
        <p role="status" style={{ color: "var(--color-dojo-jade)", fontSize: "13px", margin: 0 }}>{added}</p>
      )}

      {/* Confirmation: top-3 candidates ("Is this your card?"). */}
      {phase === "confirm" && !added && (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", overflowY: "auto" }}>
          <p style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "13px", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
            Is this your card?
          </p>
          {candidates.map((c) => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: "12px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "12px" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontWeight: 700 }}>{c.name}</p>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--color-dojo-body)" }}>
                  {c.set} · {Math.round(c.confidence * 100)}% match
                </p>
              </div>
              <button onClick={() => addCard(c)} style={{ ...goldBtn, padding: "10px 14px" }}>
                Add to Collection
              </button>
            </div>
          ))}
          <button onClick={resetToScan} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-dojo-gold)", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "11px", letterSpacing: "0.14em", textTransform: "uppercase", alignSelf: "flex-start" }}>
            None of these · Rescan
          </button>
        </div>
      )}

      {/* Not recognized: manual search fallback. */}
      {phase === "not-recognized" && !added && (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", overflowY: "auto" }}>
          <p role="alert" style={{ margin: 0, fontWeight: 700 }}>Card not recognized</p>
          <p style={{ margin: 0, fontSize: "13px", color: "var(--color-dojo-body)" }}>
            Search for it manually, or rescan.
          </p>
          <input
            type="search"
            aria-label="Search for a card"
            placeholder="Search card name…"
            value={manualQuery}
            onChange={(e) => runManualSearch(e.target.value)}
            className="dojo-input"
            style={{ width: "100%" }}
          />
          {manualResults.map((c) => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: "12px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "12px" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontWeight: 700 }}>{c.name}</p>
                {c.set && <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--color-dojo-body)" }}>{c.set}</p>}
              </div>
              <button onClick={() => addCard(c)} style={{ ...goldBtn, padding: "10px 14px" }}>
                Add to Collection
              </button>
            </div>
          ))}
          <button onClick={resetToScan} style={goldBtn}>Rescan</button>
        </div>
      )}
    </div>
  );
}
