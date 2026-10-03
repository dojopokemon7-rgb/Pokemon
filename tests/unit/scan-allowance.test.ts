import { describe, it, expect } from "vitest";
import {
  resolveScanLimit,
  remainingScans,
  DEFAULT_SCAN_LIMIT,
} from "@/lib/utils/scan-limit";
import {
  validateScanUpload,
  sniffImageMime,
  MAX_SCAN_BYTES,
} from "@/lib/utils/scan-upload";

/**
 * Scanner allowance + upload validation (pure parts). The atomic DB increment
 * (reserveSuccessfulScan) is integration-tested separately; here we pin the
 * configurable-limit resolution and the signature-based MIME/size guards that
 * decide whether a (5-credit) Vision call is even attempted.
 */
describe("resolveScanLimit (configurable, default 10)", () => {
  it("defaults to 10 when unset/empty/invalid/negative", () => {
    expect(resolveScanLimit(undefined)).toBe(DEFAULT_SCAN_LIMIT);
    expect(resolveScanLimit("")).toBe(10);
    expect(resolveScanLimit("abc")).toBe(10);
    expect(resolveScanLimit("-3")).toBe(10);
    expect(resolveScanLimit("3.5")).toBe(10);
  });
  it("honours a valid non-negative integer (paid-tier ceiling)", () => {
    expect(resolveScanLimit("25")).toBe(25);
    expect(resolveScanLimit("0")).toBe(0);
  });
});

describe("remainingScans", () => {
  it("never goes negative", () => {
    expect(remainingScans(3, 10)).toBe(7);
    expect(remainingScans(10, 10)).toBe(0);
    expect(remainingScans(12, 10)).toBe(0);
  });
});

// Minimal valid signatures.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);

describe("sniffImageMime (signature, not declared type)", () => {
  it("detects JPEG/PNG/WebP by magic bytes", () => {
    expect(sniffImageMime(JPEG)).toBe("image/jpeg");
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(WEBP)).toBe("image/webp");
  });
  it("rejects an unsupported type (GIF) and short buffers", () => {
    expect(sniffImageMime(GIF)).toBeNull();
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });
});

describe("validateScanUpload", () => {
  it("accepts a supported image within size", () => {
    expect(validateScanUpload(PNG)).toEqual({ ok: true, mime: "image/png" });
  });
  it("rejects empty, oversize, and unsupported", () => {
    expect(validateScanUpload(new Uint8Array(0))).toEqual({ ok: false, error: "empty" });
    expect(validateScanUpload(GIF)).toEqual({ ok: false, error: "unsupported" });
    // oversize: a buffer just over the cap with a valid JPEG head.
    const big = new Uint8Array(MAX_SCAN_BYTES + 1);
    big.set(JPEG.subarray(0, 3), 0);
    expect(validateScanUpload(big)).toEqual({ ok: false, error: "too-large" });
  });
});
