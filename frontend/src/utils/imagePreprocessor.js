/**
 * imagePreprocessor.js
 * Canvas-based pre-processing pipeline:
 *
 * Pokémon card layout (portrait):
 *   ┌─────────────────┐
 *   │  NAME  ·  HP    │  ← top 10%  → preprocessNameStrip()
 *   │─────────────────│
 *   │   (card art)    │
 *   │─────────────────│
 *   │  attacks/text   │
 *   │─────────────────│
 *   │  set · 074/189  │  ← bottom 8% → preprocessNumberStrip()
 *   └─────────────────┘
 *
 * Keeping crops tight avoids reading attack text as the card name.
 */

/**
 * Pre-process just the top 10% of the card — the name line only.
 * Keeping this tight prevents attack/power text leaking into OCR.
 */
export function preprocessNameStrip(source, opts = {}) {
  const { scale = 3, contrastFactor = 2.2 } = opts;

  const srcW = source.naturalWidth  || source.width;
  const srcH = source.naturalHeight || source.height;

  // Top 10% = just the name + HP row, nothing else
  const cropH = Math.floor(srcH * 0.10);

  const canvas = document.createElement('canvas');
  canvas.width  = srcW * scale;
  canvas.height = cropH * scale;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, srcW, cropH, 0, 0, canvas.width, canvas.height);

  return applyBinaryPipeline(canvas, contrastFactor);
}

/**
 * Pre-process the bottom 8% of the card — where the card number lives.
 * e.g. "074/189" or "SWSH065"
 */
export function preprocessNumberStrip(source, opts = {}) {
  const { scale = 3, contrastFactor = 2.0 } = opts;

  const srcW = source.naturalWidth  || source.width;
  const srcH = source.naturalHeight || source.height;

  const stripH  = Math.floor(srcH * 0.08);
  const startY  = srcH - stripH; // bottom 8%

  const canvas = document.createElement('canvas');
  canvas.width  = srcW * scale;
  canvas.height = stripH * scale;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, startY, srcW, stripH, 0, 0, canvas.width, canvas.height);

  return applyBinaryPipeline(canvas, contrastFactor);
}

/**
 * Pre-process the full card (for card number extraction from bottom).
 */
export function preprocessImage(source, opts = {}) {
  const { scale = 2, contrastFactor = 1.8 } = opts;

  const srcW = source.naturalWidth  || source.width;
  const srcH = source.naturalHeight || source.height;

  const canvas = document.createElement('canvas');
  canvas.width  = srcW * scale;
  canvas.height = srcH * scale;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

  return applyBinaryPipeline(canvas, contrastFactor);
}

/**
 * Shared pipeline: grayscale → contrast → Otsu threshold.
 * Mutates and returns the canvas.
 */
function applyBinaryPipeline(canvas, contrastFactor) {
  const ctx       = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data      = imageData.data;
  const total     = canvas.width * canvas.height;

  // Grayscale + contrast
  const gray = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    let lum = 0.299 * r + 0.587 * g + 0.114 * b;
    lum = Math.min(255, Math.max(0, contrastFactor * (lum - 128) + 128));
    gray[i] = lum;
  }

  // Otsu threshold → binary
  const threshold = otsuThreshold(gray);
  for (let i = 0; i < total; i++) {
    const val        = gray[i] >= threshold ? 255 : 0;
    data[i * 4]     = val;
    data[i * 4 + 1] = val;
    data[i * 4 + 2] = val;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/** Otsu's method — finds optimal global threshold. */
function otsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;

  const total  = gray.length;
  let sumAll   = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];

  let sumB = 0, wB = 0, maxVar = 0, threshold = 128;

  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const v  = wB * wF * (mB - mF) ** 2;
    if (v > maxVar) { maxVar = v; threshold = t; }
  }

  return threshold;
}
