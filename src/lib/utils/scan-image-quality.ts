/**
 * Scanner pre-upload image quality gate (F-14).
 *
 * A lightweight, DOM-free check run on a captured frame BEFORE the client fires
 * `/api/cards/recognize` (Scrydex Vision, 5 credits/call + a lifetime scan
 * allowance). Rejecting a doomed shot here saves credits and the user's
 * `User.scanCount` budget, and gives a faster "retake" loop than a round-trip
 * to a Vision call that was never going to resolve.
 *
 * Pure core (`assessScanQuality`) takes plain summary numbers so it unit-tests
 * in Node with no canvas. `statsFromImageData` is the only piece that touches
 * pixel data and it only needs a structural `{ data, width, height }` (an
 * `ImageData` satisfies it), so it also runs in jsdom/Node tests.
 */

export type ScanQualityReason = "dark" | "glare" | "blurry" | "low-contrast" | "too-small";

export interface ScanQualityResult {
  ok: boolean;
  reason?: ScanQualityReason;
}

export interface ScanQualityStats {
  /** Processed-canvas width in px. */
  width: number;
  /** Processed-canvas height in px. */
  height: number;
  /** Mean luminance, 0..255. */
  meanLuma: number;
  /** Std-dev of luminance (contrast spread), 0..~128. */
  lumaStdDev: number;
  /** Variance of a 4-neighbor gradient-magnitude pass (sharpness proxy). */
  laplacianVariance: number;
}

// --- Thresholds ------------------------------------------------------------
// ALL thresholds are deliberately LENIENT: blocking a usable shot is worse UX
// than letting an occasional bad one through to a failed Vision call. They only
// catch obviously-bad frames.
//
// ponytail: every number below is a fixed heuristic with NO per-device
// calibration. The processed canvas is 2x-upscaled + contrast-stretched
// (contrast 1.4) by the capture step, which shifts raw pixel numbers, so these
// are starting points, not spec. Upgrade path: calibrate against a corpus of
// real phone captures (and/or an on-device auto-exposure probe) and tighten.

/**
 * Min processed-canvas edge in px. The capture path 2x-upscales the crop, so a
 * real card frame is comfortably >600px/side; 240 only trips on a
 * not-ready/synthetic/degenerate frame.
 */
const MIN_EDGE_PX = 240;

/** Below this mean luminance the frame is too dark to read. */
const DARK_MEAN_LUMA = 35;
/** Above this mean luminance the frame is blown out (glare). */
const GLARE_MEAN_LUMA = 235;

/**
 * Min luminance std-dev. Direct successor to the old `variance < 120` gate
 * (sqrt(120) ≈ 10.95), rounded to 12. A flat/washed frame (blank wall, uniform
 * glare) collapses below this.
 */
const MIN_LUMA_STDDEV = 12;

/**
 * Min gradient-magnitude variance. Sharp card edges/text push this high; a
 * defocused frame collapses it toward 0.
 *
 * ponytail: this is the LEAST certain threshold and most needs on-device
 * calibration — a lenient floor (60) that catches obvious blur only. Checked
 * LAST so the physically-clearer size/brightness/contrast failures report
 * first. Upgrade path: tune against known-sharp vs known-blurry real captures.
 */
const MIN_LAPLACIAN_VARIANCE = 60;

/**
 * Grade a captured frame. First failure wins, ordered by physical clarity of
 * the signal: too-small → dark/glare → low-contrast → blurry.
 */
export function assessScanQuality(stats: ScanQualityStats): ScanQualityResult {
  if (stats.width < MIN_EDGE_PX || stats.height < MIN_EDGE_PX) {
    return { ok: false, reason: "too-small" };
  }
  if (stats.meanLuma < DARK_MEAN_LUMA) {
    return { ok: false, reason: "dark" };
  }
  if (stats.meanLuma > GLARE_MEAN_LUMA) {
    return { ok: false, reason: "glare" };
  }
  if (stats.lumaStdDev < MIN_LUMA_STDDEV) {
    return { ok: false, reason: "low-contrast" };
  }
  if (stats.laplacianVariance < MIN_LAPLACIAN_VARIANCE) {
    return { ok: false, reason: "blurry" };
  }
  return { ok: true };
}

/**
 * Compute `ScanQualityStats` from pixel data in a single pass over luminance,
 * plus a cheap sharpness pass. Takes a structural `{ data, width, height }` so
 * an `ImageData` (browser + jsdom) or a plain test object both work.
 *
 * Sharpness proxy: variance of the 4-neighbor gradient magnitude
 * (|L - Lright| + |L - Ldown|) over the luma grid — the standard cheap blur
 * metric; a full Laplacian-of-Gaussian is overkill here.
 */
export function statsFromImageData(img: {
  data: Uint8ClampedArray | number[];
  width: number;
  height: number;
}): ScanQualityStats {
  const { data, width, height } = img;
  const n = width * height;
  if (n <= 0) {
    return { width, height, meanLuma: 0, lumaStdDev: 0, laplacianVariance: 0 };
  }

  // Pass 1: build a luma grid + accumulate mean/variance of luminance.
  const luma = new Float64Array(n);
  let sum = 0;
  let sumSq = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    luma[p] = g;
    sum += g;
    sumSq += g * g;
  }
  const meanLuma = sum / n;
  const lumaVariance = Math.max(0, sumSq / n - meanLuma * meanLuma);
  const lumaStdDev = Math.sqrt(lumaVariance);

  // Pass 2: gradient-magnitude variance (sharpness). Only interior pixels have
  // a right+down neighbor; a 1px frame has none, so guard it.
  let gSum = 0;
  let gSumSq = 0;
  let gCount = 0;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const p = y * width + x;
      const grad = Math.abs(luma[p] - luma[p + 1]) + Math.abs(luma[p] - luma[p + width]);
      gSum += grad;
      gSumSq += grad * grad;
      gCount++;
    }
  }
  const laplacianVariance =
    gCount > 0 ? Math.max(0, gSumSq / gCount - (gSum / gCount) * (gSum / gCount)) : 0;

  return { width, height, meanLuma, lumaStdDev, laplacianVariance };
}
