/**
 * Pure variant-selection logic for the One Piece scanner's Phase 2 visual
 * variant match (alt-art disambiguation).
 *
 * After Phase 1 OCR resolves ONE card by its collector code, that card may
 * carry 2–4 distinct art variants (base + alt-arts). This module decides WHICH
 * variant the user physically scanned by comparing a CLIP embedding of the
 * scanned photo against a CLIP embedding of each candidate variant image, via
 * cosine similarity.
 *
 * DESIGN: this file is PURE and runs in Node/jsdom. The embedder (real CLIP) is
 * NEVER imported here — the caller injects already-computed vectors, so unit
 * tests pass controlled vectors and never touch @xenova/transformers or the
 * network. The lazy, client-only CLIP embedder lives in clip-embedder.ts.
 *
 * The confidence gate here does NOT fabricate a shown % (AGENTS RULE 2); it
 * only decides whether the top match is trustworthy enough to auto-select the
 * variant image, or whether the caller should fall back to the base art.
 */

/** A variant image to embed+compare: a display label + its (http) image URL. */
export interface VariantCandidate {
  label: string;
  url: string;
}

/** A variant candidate with its computed CLIP embedding attached. */
export interface VariantEmbedding extends VariantCandidate {
  embedding: Float32Array | number[];
}

/** The chosen variant + the raw cosine score + whether it is trustworthy. */
export interface VariantSelection {
  label: string;
  url: string;
  score: number;
  confident: boolean;
}

// Confidence floors gating the base-image FALLBACK (not a displayed %):
//  - MIN_CONFIDENCE: the top variant must be at least this similar to the scan
//    in absolute terms. CLIP cosine for a genuine same-image match sits well
//    above this; a floor of 0.2 rejects a scan that matches nothing.
//  - MARGIN: the top variant must beat the runner-up by at least this much, so
//    a near-tie (two variants almost equally similar — CLIP can't tell them
//    apart) is treated as low-confidence and falls back to the base art.
// Base-green vs alt-orange One Piece art differ strongly, so a small margin
// suffices; tune only if a live scan mis-picks (see plan "Open assumptions").
const MIN_CONFIDENCE = 0.2;
const MARGIN = 0.02;

/**
 * Cosine similarity of two equal-length vectors. Returns 0 for a mismatched or
 * zero-magnitude vector (never NaN) so the selector degrades gracefully.
 */
export function cosineSimilarity(
  a: Float32Array | number[],
  b: Float32Array | number[]
): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Pick the candidate variant whose embedding is closest to the query embedding.
 *
 * Returns null for an empty candidate list. Otherwise returns the top variant
 * with its cosine `score` and a `confident` flag: confident when the top score
 * clears MIN_CONFIDENCE AND beats the runner-up by at least MARGIN (a single
 * candidate is confident when it clears MIN_CONFIDENCE, since there is no tie to
 * resolve). The caller auto-selects the variant image only when `confident`;
 * otherwise it falls back to the base art (graceful degradation, no error).
 *
 * ponytail: cosine over a 2–4 item list is an O(n·d) linear scan; at this scale
 * no index/upgrade path is needed.
 */
export function selectBestVariant(
  queryEmbedding: Float32Array | number[],
  candidates: VariantEmbedding[],
  opts?: { minConfidence?: number }
): VariantSelection | null {
  if (candidates.length === 0) return null;
  const minConfidence = opts?.minConfidence ?? MIN_CONFIDENCE;

  let best: VariantEmbedding | null = null;
  let bestScore = -Infinity;
  let secondScore = -Infinity;
  for (const c of candidates) {
    const score = cosineSimilarity(queryEmbedding, c.embedding);
    if (score > bestScore) {
      secondScore = bestScore;
      bestScore = score;
      best = c;
    } else if (score > secondScore) {
      secondScore = score;
    }
  }
  // best is non-null here (list is non-empty).
  const topScore = bestScore;
  const confident =
    topScore >= minConfidence &&
    (candidates.length === 1 || topScore - secondScore >= MARGIN);

  return { label: best!.label, url: best!.url, score: topScore, confident };
}
