/**
 * Scan upload validation (pure) — server-side size + MIME checks against the
 * documented Scrydex Vision formats (plan §3; docs/SCRYDEX_AUDIT.md).
 *
 * We validate the ACTUAL bytes, not a client-declared type: the MIME is derived
 * from the file's magic-number signature so a renamed / spoofed extension is
 * rejected. Formats: JPEG, PNG, WebP. Max size: 20 MB.
 */

export const MAX_SCAN_BYTES = 20 * 1024 * 1024; // 20 MB (Scrydex Vision limit)
export const SUPPORTED_SCAN_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
export type SupportedScanMime = (typeof SUPPORTED_SCAN_MIME)[number];

/**
 * Sniff the real image MIME from the leading magic bytes. Returns a supported
 * MIME string or null when the signature isn't a supported image. This does NOT
 * trust any client-provided content-type.
 */
export function sniffImageMime(bytes: Uint8Array): SupportedScanMime | null {
  if (bytes.length < 12) return null;
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "image/png";
  // WebP: "RIFF"...."WEBP"
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return null;
}

export type ScanUploadError = "too-large" | "unsupported" | "empty";

export interface ScanUploadValidation {
  ok: boolean;
  mime?: SupportedScanMime;
  error?: ScanUploadError;
}

/**
 * Validate raw upload bytes: non-empty, within size, and a supported image by
 * signature. Pure — returns a discriminated result the route maps to a safe
 * error state (never throws).
 */
export function validateScanUpload(bytes: Uint8Array): ScanUploadValidation {
  if (!bytes || bytes.length === 0) return { ok: false, error: "empty" };
  if (bytes.length > MAX_SCAN_BYTES) return { ok: false, error: "too-large" };
  const mime = sniffImageMime(bytes);
  if (!mime) return { ok: false, error: "unsupported" };
  return { ok: true, mime };
}

/** Decode a base64 (optionally data-URI-prefixed) string to bytes. */
export function base64ToBytes(input: string): Uint8Array {
  const b64 = input.replace(/^data:image\/\w+;base64,/, "");
  return new Uint8Array(Buffer.from(b64, "base64"));
}
