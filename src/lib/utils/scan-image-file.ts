import {
  MAX_SCAN_BYTES,
  SUPPORTED_SCAN_MIME,
  sniffImageMime,
  type SupportedScanMime,
} from "@/lib/utils/scan-upload";

/** Client-side checks for a user-chosen scan photo (pure; the server re-validates). */

export type ScanFileErrorCode = "empty" | "too-large" | "unsupported-type" | "spoofed";

export type ScanFileValidation =
  | { ok: true; mime: SupportedScanMime }
  | { ok: false; code: ScanFileErrorCode; message: string };

const MESSAGES: Record<ScanFileErrorCode, string> = {
  empty: "That file is empty. Choose a different photo.",
  "too-large": "That photo is over 20 MB. Choose a smaller one or take a new photo.",
  "unsupported-type": "Only JPEG, PNG or WebP photos work. Choose a different file.",
  spoofed: "That file isn't a valid JPEG, PNG or WebP image. Choose a different photo.",
};

const fail = (code: ScanFileErrorCode): ScanFileValidation => ({ ok: false, code, message: MESSAGES[code] });

/** `headBytes` = first bytes of the file (>= 12 needed for the signature sniff). */
export function validateScanFile(
  file: { type: string; size: number },
  headBytes: Uint8Array
): ScanFileValidation {
  if (!file.size) return fail("empty");
  if (file.size > MAX_SCAN_BYTES) return fail("too-large");
  if (!(SUPPORTED_SCAN_MIME as readonly string[]).includes(file.type)) return fail("unsupported-type");
  const sniffed = sniffImageMime(headBytes);
  if (sniffed !== file.type) return fail("spoofed");
  return { ok: true, mime: sniffed };
}

/** Target size to fit `maxEdge` keeping aspect ratio; null = no resize needed (never upscales). */
export function computeDownscaleSize(
  width: number,
  height: number,
  maxEdge = 1600
): { width: number; height: number } | null {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return null;
  const k = maxEdge / longest;
  return { width: Math.round(width * k), height: Math.round(height * k) };
}
