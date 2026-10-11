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
 * tappable rows (image + name + set + confidence). Picking one records the
 * choice for the recognition tuning loop and opens a REVIEW sheet (the shared
 * AddCardSheet) with editable variant/condition/quantity/collection; only the
 * sheet's "Add to Portfolio" button actually adds the card.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AddCardSheet } from "@/components/AddCardSheet";
import { validateScanFile, computeDownscaleSize } from "@/lib/utils/scan-image-file";
import { readScanLanguage, writeScanLanguage, type ScanLanguage } from "@/lib/utils/scan-language";
import { readScanGame, writeScanGame, type ScanGame } from "@/lib/utils/scan-game";
import {
  assessScanQuality,
  statsFromImageData,
  type ScanQualityReason,
  type ScanQualityStats,
} from "@/lib/utils/scan-image-quality";

interface Candidate {
  id: string;
  name: string;
  // Collector number (Card.number, e.g. "081/182") — DISPLAY-ONLY, never an id.
  // Shown on each tile so the user can pick the exact printing among same-art
  // reprints (081/182 SV10 vs promo 205). Optional: the tesseract/manual
  // branches may omit it.
  number?: string | null;
  set: string;
  imageUrl: string;
  confidence: number;
}

type Phase = "scan" | "recognizing" | "confirm" | "not-recognized" | "review";

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
  // Browsers block getUserMedia on insecure origins (plain HTTP on an IP/host,
  // not localhost). That's a hard platform rule, NOT a permission the user can
  // grant — so we distinguish it from a real denial to show honest copy and
  // steer the user to the "Choose photo" upload path, which works over HTTP.
  const [cameraInsecure, setCameraInsecure] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  // The candidate the user tapped to review before adding. Non-null drives the
  // AddCardSheet review screen (phase "review"); the actual portfolio add only
  // happens from that sheet's "Add to Portfolio" button, never on tile tap.
  const [reviewCandidate, setReviewCandidate] = useState<Candidate | null>(null);
  // Phase to return to when the review sheet is cancelled (candidates can be
  // reached from either the "confirm" strip or the "not-recognized" manual
  // list — cancel should return to whichever the user came from, not add).
  const [reviewReturnPhase, setReviewReturnPhase] = useState<Phase>("confirm");

  // Language context (persisted). Sent to the API, which only echoes it.
  const [language, setLanguage] = useState<ScanLanguage>("all");
  useEffect(() => setLanguage(readScanLanguage()), []);
  function changeLanguage(next: ScanLanguage) {
    setLanguage(next);
    writeScanLanguage(next);
  }

  // Game context (persisted). Unlike language this is load-bearing: it scopes
  // the recognize/search catalog so a One Piece card is matched against the
  // One Piece catalog instead of being scanned as a Pokémon card (findings E1).
  const [game, setGame] = useState<ScanGame>("pokemon");
  useEffect(() => setGame(readScanGame()), []);
  function changeGame(next: ScanGame) {
    setGame(next);
    writeScanGame(next);
  }

  // "Choose photo": object URL of the chosen file (preview) + inline error.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  useEffect(() => {
    // Revoke on replace/unmount so chosen photos don't leak in memory.
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // Manual search fallback state.
  const [manualQuery, setManualQuery] = useState("");
  const [manualResults, setManualResults] = useState<Candidate[]>([]);

  const startCamera = useCallback(async () => {
    // Insecure context (HTTP on a non-localhost origin) → the camera API is
    // either absent or will reject. Surface the real reason up front instead of
    // a misleading "access denied", and skip the getUserMedia attempt.
    if (typeof window !== "undefined" && window.isSecureContext === false) {
      setCameraInsecure(true);
      setCameraDenied(true);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraInsecure(true);
      setCameraDenied(true);
      return;
    }
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
      setCameraInsecure(false);
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
   * contrast. Returns the processed canvas plus the quality stats fed to the
   * pre-upload gate (brightness, contrast spread, sharpness, size).
   */
  function captureProcessedCanvas(): { canvas: HTMLCanvasElement; stats: ScanQualityStats } | null {
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

    // Compute the quality-gate stats on the RAW drawn frame BEFORE the
    // contrast stretch (so brightness/contrast/sharpness reflect the real
    // capture, not the OCR-boosted pixels).
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const stats = statsFromImageData(img);

    // Grayscale + contrast in place to boost small set/number text for OCR.
    const d = img.data;
    const contrast = 1.4;
    const intercept = 128 * (1 - contrast);
    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const v = Math.max(0, Math.min(255, contrast * gray + intercept));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);

    return { canvas, stats };
  }

  /** Maps a quality-gate rejection reason to friendly retake copy. */
  function qualityMessage(reason: ScanQualityReason): string {
    switch (reason) {
      case "too-small":
        return "Hold the card closer so it fills the frame.";
      case "dark":
        return "Too dark — add light and steady the card.";
      case "glare":
        return "Too much glare — tilt the card or move away from the light.";
      case "low-contrast":
        return "Center the card against a plain background and try again.";
      case "blurry":
        return "Looks blurry — hold steady and tap Scan again.";
    }
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
      body: JSON.stringify({ image, game, language }),
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
      body: JSON.stringify({ text, game, source, language }),
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
      // Pre-upload quality gate: BLOCKING. A doomed frame never reaches the
      // Vision API, saving Scrydex credits + the lifetime scan allowance.
      const q = assessScanQuality(captured.stats);
      if (!q.ok && q.reason) {
        setWarning(qualityMessage(q.reason));
        setPhase("scan");
        return;
      }
      await recognizeCanvas(captured.canvas);
    } catch {
      setError("Scanner error, please try again.");
      setPhase("scan");
    }
  }

  /** Shared by camera + Choose photo. Vision-first; falls back to on-device
   *  tesseract when the server has no Vision key or Vision returned nothing. */
  async function recognizeCanvas(canvas: HTMLCanvasElement) {
    let result = await recognizeByImage(canvas);
    if (result == null) {
      const text = await runTesseract(canvas);
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
  }

  /** Decode honoring EXIF orientation; falls back to <img> (modern browsers
   *  apply orientation there by default). Throws if undecodable. */
  async function decodeImage(file: File): Promise<{ src: CanvasImageSource; w: number; h: number; close: () => void }> {
    if (typeof createImageBitmap === "function") {
      try {
        const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
        return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
      } catch {
        /* fall through to <img> */
      }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { src: img, w: img.naturalWidth, h: img.naturalHeight, close: () => {} };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Handle a photo picked from the device. Image data is never logged. */
  async function handleChosenFile(file: File) {
    setFileError(null);
    setError(null);
    setWarning(null);
    setAdded(null);
    try {
      const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      const check = validateScanFile(file, head);
      if (!check.ok) {
        setFileError(check.message);
        return;
      }
      const decoded = await decodeImage(file).catch(() => null);
      if (!decoded || !decoded.w || !decoded.h) {
        setFileError("We couldn't read that image. Choose a different photo.");
        return;
      }
      // Downscale large photos (<=1600px edge); on any failure, use the original size.
      const size = computeDownscaleSize(decoded.w, decoded.h) ?? { width: decoded.w, height: decoded.h };
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        decoded.close();
        setFileError("We couldn't process that image. Try a different photo.");
        return;
      }
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(decoded.src, 0, 0, size.width, size.height);
      decoded.close();

      // Same pre-upload quality gate as the camera path (parity). Blocks a
      // doomed chosen photo before it burns a Vision call.
      const q = assessScanQuality(statsFromImageData(ctx.getImageData(0, 0, canvas.width, canvas.height)));
      if (!q.ok && q.reason) {
        setFileError(qualityMessage(q.reason));
        setPhase("scan");
        return;
      }

      setPreviewUrl(URL.createObjectURL(file)); // effect revokes the previous one
      setCandidates([]);
      setPhase("recognizing");
      await recognizeCanvas(canvas);
    } catch {
      setError("Scanner error, please try again.");
      setPhase("scan");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ""; // allow re-picking the same file
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

  /**
   * Tapping a candidate opens the review screen (AddCardSheet) rather than
   * adding immediately. The pick is logged here (the tap IS the user's choice,
   * which is what the tuning loop wants to record); the real portfolio add is
   * performed only by the review screen's "Add to Portfolio" button.
   */
  function openReview(c: Candidate) {
    logPick(c.id);
    setReviewReturnPhase(phase === "not-recognized" ? "not-recognized" : "confirm");
    setReviewCandidate(c);
    setPhase("review");
  }

  async function runManualSearch(q: string) {
    setManualQuery(q);
    const query = q.trim();
    if (query.length < 2) {
      setManualResults([]);
      return;
    }
    try {
      const res = await fetch(`/api/cards/search?game=${game}&query=${encodeURIComponent(query)}`);
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
    setReviewCandidate(null);
    setPreviewUrl(null); // Retake / Rescan also drops the chosen photo (URL revoked by effect)
    setFileError(null);
    setPhase("scan");
  }

  const goldBtn: React.CSSProperties = {
    padding: "12px 20px", fontFamily: "var(--font-display)", fontWeight: 700,
    background: "var(--color-dojo-gold)", color: "var(--color-dojo-app)",
    border: "1px solid var(--color-dojo-stroke)", cursor: "pointer",
  };
  // Square icon button used in the floating top bar (close) and bottom bar
  // (gallery). Dojo card surface + stroke, radius 0 (AGENTS §5 rule 10).
  const iconBtn: React.CSSProperties = {
    width: "44px", height: "44px", flex: "none",
    border: "1px solid var(--color-dojo-stroke)", background: "var(--color-dojo-card)",
    color: "var(--color-dojo-ink)", cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
  };
  // Translucent overlay surface for the floating top/bottom bars so the camera
  // reads through behind them (Collectr-style floating controls).
  const overlayBar: React.CSSProperties = {
    position: "absolute", left: 0, right: 0, zIndex: 3,
    display: "flex", alignItems: "center", gap: "10px",
    padding: "12px 14px", background: "rgba(13,13,13,0.55)",
  };

  // The live camera path is only usable when the context is secure AND
  // permission wasn't denied. In the other two states the viewport stays black
  // and the shutter can't capture, so we steer the user to "Choose photo".
  const cameraUsable = !cameraInsecure && !cameraDenied;

  return (
    <div
      style={{
        // Full-bleed phone-first stage. The SCROLL lives on the full-bleed
        // wrapper in dashboard-client-shell.tsx (position:fixed; inset:0;
        // overflowY:auto, width-capped at 480 and centered). This root must NOT
        // be its own 100dvh scroller or the two nested scroll regions fight on
        // mobile; it fills the wrapper width and lays the camera + results out
        // in a column, letting the wrapper scroll them (preserves the
        // mobile-scroll bugfix).
        position: "relative",
        width: "100%", minHeight: "100dvh",
        background: "var(--color-dojo-app)", color: "var(--color-dojo-ink)",
        display: "flex", flexDirection: "column",
      }}
    >
      {/* ── Region A — Camera stage (first screenful, video as background) ── */}
      <div style={{ position: "relative", flex: "1 1 auto", minHeight: "68dvh", overflow: "hidden" }}>
        <video
          ref={videoRef}
          data-testid="camera-preview"
          autoPlay
          muted
          playsInline
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", background: "#000", objectFit: "cover", display: "block" }}
        />

        {/* Guide outline — a portrait card box centered in the frame, matching
            the CARD_CROP region the capture step crops to. The prominent
            Collectr-style frame: solid gold, square corners, dark scrim. */}
        <div
          data-testid="card-outline"
          aria-hidden="true"
          style={{
            position: "absolute",
            top: `${((1 - CARD_CROP.hFrac) / 2) * 100}%`,
            left: `${((1 - CARD_CROP.wFrac) / 2) * 100}%`,
            width: `${CARD_CROP.wFrac * 100}%`,
            height: `${CARD_CROP.hFrac * 100}%`,
            border: "2px solid var(--color-dojo-gold)",
            borderRadius: 0,
            boxShadow: "0 0 0 100vmax rgba(0,0,0,0.45)",
            pointerEvents: "none",
          }}
        />

        {/* ── Floating top bar: close (LEFT) · title (CENTER) · language (RIGHT) ── */}
        <div style={{ ...overlayBar, top: 0, borderBottom: "1px solid var(--color-dojo-stroke)" }}>
          <button
            onClick={() => router.back()}
            aria-label="Close"
            title="Close"
            style={iconBtn}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" aria-hidden="true">
              <line x1="3" y1="3" x2="15" y2="15" />
              <line x1="15" y1="3" x2="3" y2="15" />
            </svg>
          </button>

          <h1 className="dojo-heading" style={{ flex: 1, textAlign: "center", fontSize: "15px", letterSpacing: "0.16em", textTransform: "uppercase", margin: 0 }}>
            Card Scanner
          </h1>

          {/* Game selector. Load-bearing: scopes the recognize/search catalog
              to Pokémon or One Piece. Mirrors the language block's markup/a11y
              (label + aria-describedby + .dojo-input, SQUARE corners). Sits to
              the LEFT of the language block so the top-bar layout and e2e
              selectors are untouched (this control is purely additive). */}
          <div style={{ flex: "none", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px", minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <label htmlFor="scan-game" style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>Game</label>
              <select
                id="scan-game"
                aria-describedby="scan-game-help"
                value={game}
                onChange={(e) => changeGame(e.target.value as ScanGame)}
                className="dojo-input"
                style={{ width: "auto", height: "auto", padding: "6px 8px", fontSize: "12px" }}
              >
                <option value="pokemon">Pokémon</option>
                <option value="onepiece">One Piece</option>
              </select>
            </div>
            <p id="scan-game-help" style={{ color: "var(--color-dojo-body)", fontSize: "10px", lineHeight: 1.3, margin: 0, maxWidth: "150px", textAlign: "right" }}>
              Choose which catalog to match your card against.
            </p>
          </div>

          {/* Card language. Honest copy: catalog has no per-card language and
              photo reading is not language-restricted. Kept labeled + described
              so the a11y wiring survives the move into the bar. */}
          <div style={{ flex: "none", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px", minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <label htmlFor="scan-language" style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--color-dojo-body)" }}>Lang</label>
              <select
                id="scan-language"
                aria-describedby="scan-language-help"
                value={language}
                onChange={(e) => changeLanguage(e.target.value as ScanLanguage)}
                className="dojo-input"
                style={{ width: "auto", height: "auto", padding: "6px 8px", fontSize: "12px" }}
              >
                <option value="all">All</option>
                <option value="en">English</option>
                <option value="ja">Japanese</option>
              </select>
            </div>
            {language !== "all" && (
              <button
                type="button"
                onClick={() => changeLanguage("all")}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-dojo-gold)", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase" }}
              >
                Reset to All
              </button>
            )}
            <p id="scan-language-help" style={{ color: "var(--color-dojo-body)", fontSize: "10px", lineHeight: 1.3, margin: 0, maxWidth: "150px", textAlign: "right" }}>
              Narrows catalog matches only where a card&apos;s language is known. Reading your photo is not limited to this language.
            </p>
          </div>
        </div>

        {/* ── State overlays, centered over the (black) video ── */}
        {cameraInsecure ? (
          <div style={{ position: "absolute", inset: 0, zIndex: 2, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "10px", padding: "0 32px", textAlign: "center", pointerEvents: "none" }}>
            <p style={{ color: "var(--color-dojo-body)", fontSize: "14px", margin: 0, maxWidth: "320px" }}>
              Live camera needs a secure (HTTPS) connection, so it&apos;s unavailable here.
              Use &ldquo;Choose photo&rdquo; below to scan a card from an image instead.
            </p>
          </div>
        ) : cameraDenied ? (
          <div style={{ position: "absolute", inset: 0, zIndex: 2, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "14px", padding: "0 32px", textAlign: "center" }}>
            <p style={{ color: "var(--color-dojo-body)", fontSize: "14px", margin: 0, maxWidth: "320px" }}>
              Camera access denied. Allow camera access to scan a card.
            </p>
            <button onClick={startCamera} style={goldBtn}>
              Enable Camera
            </button>
          </div>
        ) : null}

        {/* ── Status / error overlays — visible in all three camera states.
            Floated just under the top bar so they clear the controls. ── */}
        {(warning || error || fileError || added) && (
          <div style={{ position: "absolute", top: "72px", left: "14px", right: "14px", zIndex: 4, display: "flex", flexDirection: "column", gap: "6px", pointerEvents: "none" }}>
            {warning && (
              <p role="status" style={{ background: "rgba(13,13,13,0.75)", padding: "8px 10px", color: "var(--color-dojo-gold)", fontSize: "13px", margin: 0 }}>{warning}</p>
            )}
            {error && (
              <p role="alert" style={{ background: "rgba(13,13,13,0.75)", padding: "8px 10px", color: "var(--color-dojo-ink)", fontSize: "13px", margin: 0 }}>{error}</p>
            )}
            {fileError && (
              <p role="alert" style={{ background: "rgba(13,13,13,0.75)", padding: "8px 10px", color: "var(--color-dojo-ink)", fontSize: "13px", margin: 0 }}>{fileError}</p>
            )}
            {added && (
              <p role="status" style={{ background: "rgba(13,13,13,0.75)", padding: "8px 10px", color: "var(--color-dojo-jade)", fontSize: "13px", margin: 0 }}>{added}</p>
            )}
          </div>
        )}

        {/* ── Region B — Candidate / recently-scanned strip (floats over camera,
            just above the bottom bar). Horizontal, square tiles, Collectr-style.
            The detailed not-recognized mode flows below the stage instead. ── */}
        {(phase === "recognizing" || (phase === "confirm" && !added)) && (
          <div style={{ position: "absolute", left: 0, right: 0, bottom: "104px", zIndex: 3, padding: "0 12px" }}>
            {phase === "confirm" && (
              <p style={{ margin: "0 0 8px", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "12px", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--color-dojo-ink)", textShadow: "0 1px 3px rgba(0,0,0,0.8)" }}>
                Tap your card to add it
              </p>
            )}
            {phase === "recognizing" ? (
              <div role="status" style={{ background: "rgba(13,13,13,0.75)", border: "1px solid var(--color-dojo-stroke)", padding: "14px", color: "var(--color-dojo-body)", fontSize: "13px" }}>
                Loading…
              </div>
            ) : (
              <div style={{ display: "flex", gap: "10px", overflowX: "auto", paddingBottom: "4px" }}>
                {candidates.map((c, i) => (
                  <button
                    key={c.id}
                    onClick={() => openReview(c)}
                    aria-label={`Add ${c.name} to your portfolio`}
                    style={{ flex: "none", width: "128px", display: "flex", flexDirection: "column", gap: "6px", background: "rgba(13,13,13,0.85)", border: i === 0 ? "1px solid var(--color-dojo-gold)" : "1px solid var(--color-dojo-stroke)", padding: "8px", cursor: "pointer", textAlign: "left" }}
                  >
                    {/* Candidate thumbnail (initials fallback when no image). */}
                    <div style={{ width: "100%", aspectRatio: "660 / 921", background: "var(--color-dojo-raised)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                      {c.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={c.imageUrl} alt={c.name} decoding="async" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      ) : (
                        <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "16px", color: "var(--color-dojo-gold)" }}>
                          {c.name.slice(0, 2).toUpperCase()}
                        </span>
                      )}
                    </div>
                    <p style={{ margin: 0, fontWeight: 700, fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</p>
                    {/* Collector number (prominent — the disambiguator between
                        same-art reprints) + set + confidence. Number shown only
                        when the candidate carries a real Card.number (never
                        fabricated — AGENTS §5 rule 2); price omitted (no real
                        value on the candidate today). */}
                    {c.number ? (
                      <p style={{ margin: 0, fontSize: "12px", fontWeight: 700, color: "var(--color-dojo-gold)" }}>#{c.number}</p>
                    ) : null}
                    <p style={{ margin: 0, fontSize: "11px", color: "var(--color-dojo-body)" }}>
                      {c.set ? `${c.set} · ` : ""}{Math.round(c.confidence * 100)}% match
                    </p>
                  </button>
                ))}
                {/* Not your card? Search manually. */}
                <button
                  onClick={() => { setCandidates([]); setPhase("not-recognized"); }}
                  style={{ flex: "none", width: "128px", background: "rgba(13,13,13,0.85)", border: "1px solid var(--color-dojo-stroke)", cursor: "pointer", color: "var(--color-dojo-gold)", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "11px", letterSpacing: "0.12em", textTransform: "uppercase", padding: "8px" }}
                >
                  Not your card? Search manually
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Region C — Bottom control bar: gallery (LEFT) · shutter (CENTER) ·
            reserved slot (RIGHT) ── */}
        <div style={{ ...overlayBar, bottom: 0, justifyContent: "space-between", paddingBottom: "max(14px, env(safe-area-inset-bottom))" }}>
          {/* Hidden file input (unchanged) — triggered by the gallery button. */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            data-testid="scan-file-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleChosenFile(f);
            }}
          />

          {/* LEFT: gallery / photo-picker icon-button → same handler as the old
              "Choose photo" text button. When a photo is chosen, show its small
              preview + "Retake" (resetToScan) in this slot. */}
          {previewUrl ? (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl} alt="Chosen card photo preview" style={{ height: "44px", width: "auto", border: "1px solid var(--color-dojo-stroke)" }} />
              <button
                type="button"
                onClick={resetToScan}
                disabled={phase === "recognizing"}
                style={{ ...goldBtn, padding: "10px 14px" }}
              >
                Retake
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Choose photo"
              title="Choose photo"
              style={iconBtn}
            >
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
                <rect x="2.5" y="4.5" width="17" height="13" />
                <path d="M2.5 14l5-4 4 3 3-2.5 5 4" />
                <circle cx="8" cy="8.5" r="1.4" />
              </svg>
            </button>
          )}

          {/* CENTER: circular shutter — the ONE allowed rounded element. Hidden
              when the live camera can't capture (insecure/denied), steering to
              the gallery button. Disabled + dimmed while recognizing (keeps the
              "Scanning…" semantics via aria-label; still named "Scan" at rest so
              the e2e /^scan$/i matcher resolves it). */}
          {cameraUsable ? (
            <button
              onClick={handleScan}
              disabled={phase === "recognizing"}
              aria-label={phase === "recognizing" ? "Scanning…" : "Scan"}
              style={{
                width: "72px", height: "72px", flex: "none", borderRadius: "50%",
                background: "var(--color-dojo-gold)", color: "var(--color-dojo-app)",
                border: "4px solid var(--color-dojo-app)",
                boxShadow: "0 0 0 2px var(--color-dojo-gold)",
                cursor: phase === "recognizing" ? "default" : "pointer",
                opacity: phase === "recognizing" ? 0.7 : 1,
                fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "11px",
                letterSpacing: "0.08em", textTransform: "uppercase",
              }}
            >
              {phase === "recognizing" ? "…" : ""}
            </button>
          ) : (
            // Keep the shutter's footprint so the gallery button stays left-anchored.
            <span style={{ width: "72px", flex: "none" }} aria-hidden="true" />
          )}

          {/* RIGHT: reserved secondary-action slot. No global "next" action
              exists today (tapping a candidate opens the review sheet, and the
              add happens from there), so this is an intentionally-empty
              equal-width spacer that balances the shutter — NOT dead code. A
              real next affordance would use <ArrowRight/> here. */}
          <span style={{ width: "44px", flex: "none" }} aria-hidden="true" />
        </div>
      </div>

      {/* ── Not recognized / manual search fallback (flows below the stage;
          a distinct mode, reachable by scrolling the shell wrapper). ── */}
      {phase === "not-recognized" && !added && (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", padding: "20px 16px" }}>
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
              onClick={() => openReview(c)}
              aria-label={`Add ${c.name} to your portfolio`}
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

      {/* ── Added confirmation (flows below the stage) with a way back to scan. ── */}
      {added && (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", padding: "20px 16px" }}>
          <button onClick={resetToScan} style={goldBtn}>Scan another</button>
        </div>
      )}

      {/* ── Review before add (phase "review") — the shared AddCardSheet is the
          review editor, driven by the tapped candidate. It owns variant/grader,
          condition, quantity, collection, optional price-paid, the ownership-
          scoped POST, and the ['collection']/['portfolio-collection']/
          ['collections'] invalidations. Only its "Add to Portfolio" button
          performs the add; tapping a tile just opens this. The candidate has no
          real price → header shows "—" (RULE 2). A One Piece candidate's
          imageUrl is the /api/one-piece-img proxy path — displayed here, never
          POSTed (guarded in AddCardSheet.handleAdd; RULE 13). onClose returns to
          the candidate list without adding; onAdded surfaces the existing
          "Added <name> to your portfolio" feedback and returns to scan. ── */}
      {reviewCandidate && (
        <AddCardSheet
          card={{
            externalId: reviewCandidate.id,
            name: reviewCandidate.name,
            setName: reviewCandidate.set || null,
            imageUrl: reviewCandidate.imageUrl || null,
            marketPrice: null,
            gradedPrices: [],
          }}
          onClose={() => {
            setReviewCandidate(null);
            setPhase(reviewReturnPhase);
          }}
          onAdded={(msg) => {
            setReviewCandidate(null);
            setAdded(msg);
            setPhase("scan");
          }}
        />
      )}
    </div>
  );
}
