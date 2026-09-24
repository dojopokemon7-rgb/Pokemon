/**
 * Google Cloud Vision OCR (F-14 scanner).
 *
 * Runs TEXT_DETECTION on a captured card photo. Server-side only — the
 * GOOGLE_VISION_API_KEY is a secret and must never reach the browser, so the
 * scanner sends the base64 image to our recognize route, which calls this.
 *
 * Returns the detected text, or `null` when Vision can't be used (no key
 * configured, or the API call failed / returned no text). `null` is the
 * signal for the caller to fall back to on-device tesseract.js OCR.
 */

const VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";

/** Strips a data-URL prefix ("data:image/png;base64,") if present — Vision
 *  wants the raw base64 payload only. */
function stripDataUrl(base64: string): string {
  const comma = base64.indexOf(",");
  return base64.startsWith("data:") && comma !== -1 ? base64.slice(comma + 1) : base64;
}

/** True when a Vision API key is configured (lets the route decide the path
 *  without attempting a doomed call). */
export function isVisionConfigured(): boolean {
  return Boolean(process.env.GOOGLE_VISION_API_KEY);
}

/**
 * OCRs a base64-encoded image via Vision TEXT_DETECTION.
 *
 * @param imageBase64 the image bytes as base64 (with or without data-URL prefix)
 * @returns the full detected text, or null if Vision is unavailable/failed.
 */
export async function detectTextWithVision(imageBase64: string): Promise<string | null> {
  const key = process.env.GOOGLE_VISION_API_KEY;
  if (!key) return null;

  const content = stripDataUrl(imageBase64);
  if (!content) return null;

  try {
    const res = await fetch(`${VISION_ENDPOINT}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content },
            features: [{ type: "TEXT_DETECTION", maxResults: 1 }],
            // Bias detection toward Latin-script card text.
            imageContext: { languageHints: ["en"] },
          },
        ],
      }),
    });

    if (!res.ok) {
      console.warn("[vision-ocr] Vision API returned", res.status);
      return null;
    }

    const data = (await res.json()) as {
      responses?: Array<{
        // fullTextAnnotation.text is the whole detected block; textAnnotations[0]
        // is the same text as a fallback for older response shapes.
        fullTextAnnotation?: { text?: string };
        textAnnotations?: Array<{ description?: string }>;
        error?: { message?: string };
      }>;
    };

    const r = data.responses?.[0];
    if (r?.error?.message) {
      console.warn("[vision-ocr] Vision error:", r.error.message);
      return null;
    }
    const text = r?.fullTextAnnotation?.text ?? r?.textAnnotations?.[0]?.description ?? "";
    return text.trim() || null;
  } catch (err) {
    console.warn(
      "[vision-ocr] Vision call failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
