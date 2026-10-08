import { describe, it, expect } from "vitest";
import {
  assessScanQuality,
  statsFromImageData,
  type ScanQualityStats,
} from "@/lib/utils/scan-image-quality";

// A clean, passing baseline: large, mid-bright, contrasty, sharp.
const GOOD: ScanQualityStats = {
  width: 600,
  height: 800,
  meanLuma: 128,
  lumaStdDev: 55,
  laplacianVariance: 400,
};

describe("assessScanQuality", () => {
  it("passes a clean bright/sharp/contrasty normal-size frame", () => {
    expect(assessScanQuality(GOOD)).toEqual({ ok: true });
  });

  it("rejects a tiny frame as too-small", () => {
    expect(assessScanQuality({ ...GOOD, width: 100, height: 100 })).toEqual({
      ok: false,
      reason: "too-small",
    });
  });

  it("rejects a dark frame", () => {
    expect(assessScanQuality({ ...GOOD, meanLuma: 10 })).toEqual({
      ok: false,
      reason: "dark",
    });
  });

  it("rejects a blown-out frame as glare", () => {
    expect(assessScanQuality({ ...GOOD, meanLuma: 250 })).toEqual({
      ok: false,
      reason: "glare",
    });
  });

  it("rejects a flat frame as low-contrast", () => {
    expect(assessScanQuality({ ...GOOD, lumaStdDev: 3 })).toEqual({
      ok: false,
      reason: "low-contrast",
    });
  });

  it("rejects an out-of-focus frame as blurry", () => {
    expect(assessScanQuality({ ...GOOD, laplacianVariance: 10 })).toEqual({
      ok: false,
      reason: "blurry",
    });
  });

  it("reports the earlier reason when multiple checks fail (precedence)", () => {
    // Too-small AND dark AND blurry → too-small wins (checked first).
    expect(
      assessScanQuality({ ...GOOD, width: 50, height: 50, meanLuma: 5, laplacianVariance: 1 })
    ).toEqual({ ok: false, reason: "too-small" });
    // Dark AND low-contrast AND blurry (size ok) → dark wins.
    expect(
      assessScanQuality({ ...GOOD, meanLuma: 5, lumaStdDev: 1, laplacianVariance: 1 })
    ).toEqual({ ok: false, reason: "dark" });
  });
});

describe("statsFromImageData", () => {
  // Builds RGBA data where every pixel is the given gray value.
  function solid(width: number, height: number, gray: number) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < width * height; p++) {
      const i = p * 4;
      data[i] = data[i + 1] = data[i + 2] = gray;
      data[i + 3] = 255;
    }
    return { data, width, height };
  }

  it("reports ~zero contrast and sharpness for a flat gray frame", () => {
    const stats = statsFromImageData(solid(300, 300, 128));
    expect(stats.meanLuma).toBeCloseTo(128, 0);
    expect(stats.lumaStdDev).toBeCloseTo(0, 5);
    expect(stats.laplacianVariance).toBeCloseTo(0, 5);
    // A flat frame is caught as low-contrast.
    expect(assessScanQuality(stats).reason).toBe("low-contrast");
  });

  it("reports high contrast and sharpness for a black/white block checker", () => {
    // 20px blocks (not 1px): most interior pixels have zero gradient, block
    // boundaries spike — that MIX gives a real gradient-magnitude variance,
    // whereas a 1px checker's gradient is a constant (variance 0).
    const width = 300;
    const height = 300;
    const block = 20;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const v = (Math.floor(x / block) + Math.floor(y / block)) % 2 === 0 ? 0 : 255;
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    const stats = statsFromImageData({ data, width, height });
    expect(stats.lumaStdDev).toBeGreaterThan(100);
    expect(stats.laplacianVariance).toBeGreaterThan(60);
    expect(assessScanQuality(stats)).toEqual({ ok: true });
  });

  it("handles a degenerate zero-area frame without throwing", () => {
    expect(statsFromImageData({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toEqual({
      width: 0,
      height: 0,
      meanLuma: 0,
      lumaStdDev: 0,
      laplacianVariance: 0,
    });
  });
});
