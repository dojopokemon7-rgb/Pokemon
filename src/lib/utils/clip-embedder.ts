/**
 * Client-only CLIP image embedder for the One Piece scanner's Phase 2 visual
 * variant match. Lazily loads @xenova/transformers (CLIP, Xenova/clip-vit-base-
 * patch32) on FIRST use so NOTHING downloads until a variant disambiguation is
 * actually needed. On-device only — spends NO Scrydex credits and NO scan
 * allowance, and never touches the recognize route's credit/allowance ordering.
 *
 * The ~90MB ONNX model is fetched once from the Hugging Face Hub (CSP
 * connect-src is extended for huggingface.co + its CDN in next.config.ts) and
 * then browser-cached. Each variant IMAGE URL is also fetched by transformers.js
 * to embed it (connect-src images.scrydex.com), so the pure selector in
 * variant-visual-match.ts can compare them to the scanned photo.
 *
 * ALL exported functions REJECT/throw on any failure (model load blocked, CSP
 * block, fetch error) — the caller treats any throw as "CLIP unavailable" and
 * falls back to the base image (graceful degradation, never an error).
 *
 * TEST SEAM: when `window.__mockClipEmbedder` is set (an object with
 * embedImageFromUrl / embedImageFromCanvas), it is used instead of real CLIP —
 * mirroring the existing `window.__mockOcrText` seam so e2e/manual flows bypass
 * the real model with controlled vectors.
 */

// The transformers.js image-feature-extraction pipeline (loaded lazily). Typed
// loosely because the dynamic import is the only reference and we must NOT pull
// the package into the initial client bundle via a top-level import.
type FeatureExtractor = (
  input: unknown,
  opts?: Record<string, unknown>
) => Promise<{ data: Float32Array | number[] }>;

export interface ClipEmbedder {
  embedImageFromUrl(url: string): Promise<number[]>;
  embedImageFromCanvas(canvas: HTMLCanvasElement): Promise<number[]>;
}

// Memoized pipeline promise — the model loads/initializes exactly once.
let extractorPromise: Promise<FeatureExtractor> | null = null;

// In-memory cache of variant-image embeddings keyed by image URL. Variant art
// is immutable, so its embedding is stable and safe to reuse for the session.
// The query/canvas embedding is NEVER cached (it changes every scan).
const urlEmbeddingCache = new Map<string, number[]>();

function mockEmbedder(): ClipEmbedder | null {
  if (typeof window === "undefined") return null;
  const injected = (window as unknown as { __mockClipEmbedder?: ClipEmbedder })
    .__mockClipEmbedder;
  return injected ?? null;
}

/** Lazily load + memoize the CLIP image-feature-extraction pipeline. */
async function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      // Dynamic import: the ONLY reference to @xenova/transformers, so it is
      // never part of the initial scanner bundle (plan step 3).
      const { pipeline, env } = await import("@xenova/transformers");
      // Force a Hub fetch of the model (no bundled/local weights).
      env.allowLocalModels = false;
      return (await pipeline(
        "image-feature-extraction",
        "Xenova/clip-vit-base-patch32"
      )) as unknown as FeatureExtractor;
    })();
  }
  return extractorPromise;
}

/** Run CLIP over a RawImage/canvas input and return a plain number[] vector. */
async function embed(input: unknown): Promise<number[]> {
  const extractor = await getExtractor();
  // pooling/normalize give a single L2-normalized vector per image, so cosine
  // similarity in the pure selector compares like-for-like.
  const output = await extractor(input, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

/**
 * Embed a variant image by URL (cached). transformers.js fetches the URL
 * itself, so images.scrydex.com must be in CSP connect-src. Throws on failure.
 */
export async function embedImageFromUrl(url: string): Promise<number[]> {
  const mock = mockEmbedder();
  if (mock) return mock.embedImageFromUrl(url);

  const cached = urlEmbeddingCache.get(url);
  if (cached) return cached;

  const { RawImage } = await import("@xenova/transformers");
  const image = await RawImage.fromURL(url);
  const vector = await embed(image);
  urlEmbeddingCache.set(url, vector);
  return vector;
}

/** Convert a canvas to a Blob (transformers.js 2.17.2 has no RawImage.fromCanvas). */
function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("canvas-to-blob-failed"))),
      "image/png"
    );
  });
}

/**
 * Embed the user's scanned image from the scanner's color capture canvas. NOT
 * cached (every scan is a new query). Throws on failure. transformers.js 2.17.2
 * exposes no RawImage.fromCanvas, so we go via a PNG Blob → RawImage.fromBlob.
 */
export async function embedImageFromCanvas(
  canvas: HTMLCanvasElement
): Promise<number[]> {
  const mock = mockEmbedder();
  if (mock) return mock.embedImageFromCanvas(canvas);

  const { RawImage } = await import("@xenova/transformers");
  const blob = await canvasToBlob(canvas);
  const image = await RawImage.fromBlob(blob);
  return embed(image);
}

/**
 * Returns the active embedder (the real CLIP functions, or the injected mock).
 * The caller invokes this only when a variant disambiguation is actually
 * needed, so the real model is lazy-loaded exactly once at that point.
 */
export function getImageEmbedder(): ClipEmbedder {
  return mockEmbedder() ?? { embedImageFromUrl, embedImageFromCanvas };
}
