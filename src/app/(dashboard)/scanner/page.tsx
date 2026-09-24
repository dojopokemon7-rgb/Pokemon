"use client";

/**
 * Card Scanner (/scanner) — F-14, multi-signal recognition.
 *
 * Flow: rear-camera live preview with a card-shaped framing outline →
 * "Scan" captures a frame → auto-crop to the outline → preprocess (2x
 * upscale, grayscale, contrast) → a glare/brightness check warns if the
 * shot is unusable → the base64 image is POSTed to /api/cards/recognize,
 * which OCRs it with Google Cloud Vision and runs the multi-signal matching
 * engine (number + set + name). If the server has no Vision key it replies
 * `ocrSource: "unavailable"`, and the client falls back to on-device
 * tesseract.js OCR and re-submits the text. The TOP 5 candidates show as
 * tappable rows (image + name + set + confidence); picking one adds it and
 * records the choice for the recognition tuning loop.
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

// Below this top-match confidence we don't auto-trust the result (Task 2 §4).
const CONFIDENCE_THRESHOLD = 0.4;
// Crop region as a fraction of the frame — matches the on-screen outline
// (a portrait card box centered in the viewfinder).
const CARD_CROP = { wFrac: 0.72, hFrac: 0.9 };

export default function ScannerPage() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [phase, setPhase] = useState<Phase>("scan");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [feedbackId, setFeedbackId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [cameraDenied, setCameraDenied] = useState(false);
  const [added, setAdded] = useState<string | null>(null);

  // Manual search fallback state.
  const [manualQuery, setManualQuery] = useState("");
  const [manualResults, setManualResults] = useState<Candidate[]>([]);

  const startCamera = useCallback(async () => {
    try {
      let stream: MediaStream;
      try {
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

  /**
   * Capture → auto-crop to the card outline → 2x upscale → grayscale +
   * contrast. Returns the processed canvas plus a brightness-variance signal
   * used to warn about glare / too-dark shots.
   */
  function captureProcessedCanvas(): { canvas: HTMLCanvasElement; quality: QualitySignal } | null {
    const video = videoRef.current;
    if (!video) return null;
    const vw = video.videoWidth || 320;
    const vh = video.videoHeight || 320;

    // Crop to the card outline region (centered portrait box).
    const cropW = Math.round(vw * CARD_CROP.wFrac);
    const cropH = Math.round(vh * CARD_CROP.hFrac);
    const sx = Math.round((vw - cropW) / 2);
    const sy = Math.round((vh - cropH) / 2);

    // 2x upscale so small set/number text survives OCR.
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = cropW * scale;
    canvas.height = cropH * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    try {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, canvas.width, canvas.height);
    } catch {
      /* proceed with a blank canvas (synthetic/not-ready source) */
    }

    // Grayscale + contrast; collect brightness stats for the glare check.
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const contrast = 1.4;
    const intercept = 128 * (1 - contrast);
    let sum = 0;
    let sumSq = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const v = Math.max(0, Math.min(255, contrast * gray + intercept));
      d[i] = d[i + 1] = d[i + 2] = v;
      sum += gray;
      sumSq += gray * gray;
    }
    ctx.putImageData(img, 0, 0);

    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    return { canvas, quality: { mean, variance } };
  }

  /** Returns a warning string if the capture looks unusable, else null. */
  function qualityWarning(q: QualitySignal): string | null {
    // Very low variance = flat image (blank / severe glare washout or a dark
    // frame). Very high mean with low variance = blown-out glare. Thresholds
    // are heuristic — tuned to flag obviously-bad shots, not borderline ones.
    // ponytail: fixed thresholds, no per-device calibration; a proper
    // auto-exposure probe would adapt, but this catches the common cases.
    if (q.variance < 120) {
      return q.mean > 200
        ? "Too much glare — tilt the card or move away from the light."
        : "Too dark or blurry — move closer and steady the card.";
    }
    return null;
  }

  /** On-device OCR fallback (tesseract.js). Test seam: window.__mockOcrText. */
  async function runTesseract(canvas: HTMLCanvasElement): Promise<string> {
    const injected = (window as unknown as { __mockOcrText?: string }).__mockOcrText;
    if (typeof injected === "string") return injected.trim();
    const { recognize: ocr } = await import("tesseract.js");
    const { data } = await ocr(canvas, "eng");
    return (data.text ?? "").trim();
  }

  /** Recognize by IMAGE (server-side Vision). Returns null when the server
   *  has no Vision key / it failed, signaling the tesseract fallback. */
  async function recognizeByImage(
    canvas: HTMLCanvasElement
  ): Promise<{ candidates: Candidate[]; feedbackId: string | null } | null> {
    const image = canvas.toDataURL("image/jpeg", 0.85);
    const res = await fetch("/api/cards/recognize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image, game: "pokemon" }),
    });
    if (!res.ok) throw new Error("recognize failed");
    const data = await res.json().catch(() => null);
    if (data?.ocrSource === "unavailable") return null; // → tesseract fallback
    return {
      candidates: (data?.candidates ?? []) as Candidate[],
      feedbackId: data?.feedbackId ?? null,
    };
  }

  /** Recognize by TEXT (tesseract fallback / manual). */
  async function recognizeByText(
    text: string,
    source: "tesseract" | "manual"
  ): Promise<{ candidates: Candidate[]; feedbackId: string | null }> {
    const res = await fetch("/api/cards/recognize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, game: "pokemon", source }),
    });
    if (!res.ok) throw new Error("recognize failed");
    const data = await res.json().catch(() => null);
    return {
      candidates: (data?.candidates ?? []) as Candidate[],
      feedbackId: data?.feedbackId ?? null,
    };
  }

  async function handleScan() {
    setError(null);
    setWarning(null);
    setPhase("recognizing");
    try {
      const captured = captureProcessedCanvas();
      if (!captured) {
        setError("Couldn't capture a frame. Try again.");
        setPhase("scan");
        return;
      }
      const warn = qualityWarning(captured.quality);
      if (warn) setWarning(warn); // non-blocking: still attempt recognition

      // Vision-first: send the image; fall back to on-device tesseract when
      // the server has no Vision key or Vision returned nothing.
      let result = await recognizeByImage(captured.canvas);
      if (result == null) {
        const text = await runTesseract(captured.canvas);
        result = await recognizeByText(text, "tesseract");
      }

      const top = result.candidates[0];
      setFeedbackId(result.feedbackId);
      if (!top || top.confidence < CONFIDENCE_THRESHOLD) {
        setCandidates([]);
        setPhase("not-recognized");
        return;
      }
      setCandidates(result.candidates);
      setPhase("confirm");
    } catch {
      setError("Scanner error, please try again.");
      setPhase("scan");
    }
  }

  /** Records the user's pick for the recognition tuning loop (best-effort). */
  function logPick(cardId: string) {
    if (!feedbackId) return;
    void fetch("/api/cards/recognize", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedbackId, pickedCardId: cardId }),
    }).catch(() => {});
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
      logPick(c.id);
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
    setWarning(null);
    setAdded(null);
    setFeedbackId(null);
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
        style={{ position: "absolute", top: "18px", right: "22px", zIndex: 3, width: "38px", height: "38px", border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)", color: "var(--color-dojo-ink)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
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
        Line the card up inside the frame, then tap Scan.
      </p>

      {/* Camera preview with a card-shaped framing outline overlay. */}
      <div style={{ position: "relative", width: "100%", maxHeight: "360px", flex: "none" }}>
        <video
          ref={videoRef}
          data-testid="camera-preview"
          autoPlay
          muted
          playsInline
          style={{ width: "100%", maxHeight: "360px", background: "#000", border: "1px solid var(--color-dojo-stroke)", objectFit: "cover", display: "block" }}
        />
        {/* Guide outline — a portrait card box centered in the frame, matching
            the CARD_CROP region the capture step crops to. */}
        <div
          data-testid="card-outline"
          aria-hidden="true"
          style={{
            position: "absolute",
            top: `${((1 - CARD_CROP.hFrac) / 2) * 100}%`,
            left: `${((1 - CARD_CROP.wFrac) / 2) * 100}%`,
            width: `${CARD_CROP.wFrac * 100}%`,
            height: `${CARD_CROP.hFrac * 100}%`,
            border: "2px dashed var(--color-dojo-gold)",
            borderRadius: "10px",
            boxShadow: "0 0 0 100vmax rgba(0,0,0,0.35)",
            pointerEvents: "none",
          }}
        />
      </div>

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

      {warning && (
        <p role="status" style={{ color: "var(--color-dojo-gold)", fontSize: "13px", margin: 0 }}>{warning}</p>
      )}
      {error && (
        <p role="alert" style={{ color: "var(--color-dojo-body)", fontSize: "13px", margin: 0 }}>{error}</p>
      )}
      {added && (
        <p role="status" style={{ color: "var(--color-dojo-jade)", fontSize: "13px", margin: 0 }}>{added}</p>
      )}

      {/* Confirmation: top-5 candidates ("Is this your card?"). */}
      {phase === "confirm" && !added && (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", overflowY: "auto" }}>
          <p style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "13px", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>
            Is this your card?
          </p>
          {candidates.map((c) => (
            <button
              key={c.id}
              onClick={() => addCard(c)}
              style={{ display: "flex", alignItems: "center", gap: "12px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "10px", cursor: "pointer", textAlign: "left", width: "100%" }}
            >
              {/* Candidate thumbnail (initials fallback when no image). */}
              <div style={{ flex: "none", width: "40px", aspectRatio: "660 / 921", background: "var(--color-dojo-raised)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                {c.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.imageUrl} alt={c.name} decoding="async" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "12px", color: "var(--color-dojo-gold)" }}>
                    {c.name.slice(0, 2).toUpperCase()}
                  </span>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontWeight: 700 }}>{c.name}</p>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--color-dojo-body)" }}>
                  {c.set ? `${c.set} · ` : ""}{Math.round(c.confidence * 100)}% match
                </p>
              </div>
            </button>
          ))}
          {/* Not your card? Search manually. */}
          <button
            onClick={() => { setCandidates([]); setPhase("not-recognized"); }}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-dojo-gold)", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "11px", letterSpacing: "0.14em", textTransform: "uppercase", alignSelf: "flex-start" }}
          >
            Not your card? Search manually
          </button>
        </div>
      )}

      {/* Not recognized / manual search fallback. */}
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
            <button
              key={c.id}
              onClick={() => addCard(c)}
              style={{ display: "flex", alignItems: "center", gap: "12px", background: "var(--color-dojo-card)", border: "1px solid var(--color-dojo-stroke)", padding: "10px", cursor: "pointer", textAlign: "left", width: "100%" }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontWeight: 700 }}>{c.name}</p>
                {c.set && <p style={{ margin: "2px 0 0", fontSize: "12px", color: "var(--color-dojo-body)" }}>{c.set}</p>}
              </div>
              <span style={{ ...goldBtn, padding: "10px 14px" }}>Add</span>
            </button>
          ))}
          <button onClick={resetToScan} style={goldBtn}>Rescan</button>
        </div>
      )}
    </div>
  );
}

interface QualitySignal {
  mean: number;
  variance: number;
}
