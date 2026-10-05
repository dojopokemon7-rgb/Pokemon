import { describe, it, expect } from "vitest";
import { validateScanFile, computeDownscaleSize } from "@/lib/utils/scan-image-file";
import { MAX_SCAN_BYTES } from "@/lib/utils/scan-upload";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const TEXT = new Uint8Array(12).fill(0x41);

describe("validateScanFile", () => {
  it("accepts jpeg/png/webp when MIME and magic bytes agree", () => {
    expect(validateScanFile({ type: "image/jpeg", size: 100 }, JPEG)).toMatchObject({ ok: true, mime: "image/jpeg" });
    expect(validateScanFile({ type: "image/png", size: 100 }, PNG)).toMatchObject({ ok: true, mime: "image/png" });
    expect(validateScanFile({ type: "image/webp", size: 100 }, WEBP)).toMatchObject({ ok: true, mime: "image/webp" });
  });

  it("rejects empty files", () => {
    expect(validateScanFile({ type: "image/jpeg", size: 0 }, new Uint8Array())).toMatchObject({ ok: false, code: "empty" });
  });

  it("rejects files over MAX_SCAN_BYTES", () => {
    const r = validateScanFile({ type: "image/jpeg", size: MAX_SCAN_BYTES + 1 }, JPEG);
    expect(r).toMatchObject({ ok: false, code: "too-large" });
    expect(validateScanFile({ type: "image/jpeg", size: MAX_SCAN_BYTES }, JPEG).ok).toBe(true);
  });

  it("rejects a declared non-supported MIME", () => {
    expect(validateScanFile({ type: "image/gif", size: 100 }, JPEG)).toMatchObject({ ok: false, code: "unsupported-type" });
    expect(validateScanFile({ type: "", size: 100 }, JPEG)).toMatchObject({ ok: false, code: "unsupported-type" });
  });

  it("rejects spoofed MIME (bytes are not an image, or a different image type)", () => {
    expect(validateScanFile({ type: "image/png", size: 100 }, TEXT)).toMatchObject({ ok: false, code: "spoofed" });
    expect(validateScanFile({ type: "image/png", size: 100 }, JPEG)).toMatchObject({ ok: false, code: "spoofed" });
  });

  it("returns an actionable message for every failure", () => {
    const r = validateScanFile({ type: "image/gif", size: 1 }, JPEG);
    expect(!r.ok && r.message.length).toBeGreaterThan(10);
  });
});

describe("computeDownscaleSize", () => {
  it("returns null when already within maxEdge (never upscales)", () => {
    expect(computeDownscaleSize(800, 600)).toBeNull();
    expect(computeDownscaleSize(1600, 1600)).toBeNull();
  });

  it("keeps aspect ratio for landscape and portrait", () => {
    expect(computeDownscaleSize(3200, 1600)).toEqual({ width: 1600, height: 800 });
    expect(computeDownscaleSize(1500, 3000)).toEqual({ width: 800, height: 1600 });
  });

  it("honors a custom maxEdge and ignores invalid dimensions", () => {
    expect(computeDownscaleSize(2000, 1000, 1000)).toEqual({ width: 1000, height: 500 });
    expect(computeDownscaleSize(0, 100)).toBeNull();
    expect(computeDownscaleSize(NaN, 100)).toBeNull();
  });
});
