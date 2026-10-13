import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  selectBestVariant,
  type VariantEmbedding,
} from "@/lib/utils/variant-visual-match";

/**
 * Phase 2 variant selector — the PURE visual-match decision. All vectors are
 * hand-written: this test NEVER imports @xenova/transformers and NEVER hits the
 * network (the embedder is injected by the real caller; here we pass controlled
 * embeddings directly). This is the runnable check for the selection logic.
 */

describe("cosineSimilarity", () => {
  it("≈ 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it("≈ 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it("returns 0 for empty or mismatched-length vectors (never NaN)", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0); // zero-magnitude
  });
});

describe("selectBestVariant", () => {
  // A base-art vector and an alt-art vector that are clearly different, plus a
  // query that is (nearly) the alt-art — the real "scanned the orange alt" case.
  const candidates: VariantEmbedding[] = [
    { label: "base", url: "https://images.scrydex.com/op08-023.png", embedding: [1, 0, 0] },
    { label: "altArt", url: "https://images.scrydex.com/op08-023a.png", embedding: [0, 1, 0] },
    { label: "manga", url: "https://images.scrydex.com/op08-023m.png", embedding: [0, 0, 1] },
  ];

  it("returns the altArt when the query is closest to the altArt vector", () => {
    const query = [0.05, 0.98, 0.02]; // nearly the altArt vector
    const result = selectBestVariant(query, candidates);
    expect(result).not.toBeNull();
    expect(result!.label).toBe("altArt");
    expect(result!.url).toBe("https://images.scrydex.com/op08-023a.png");
    expect(result!.confident).toBe(true);
  });

  it("returns the single candidate (confident when it clears the floor)", () => {
    const only: VariantEmbedding[] = [
      { label: "base", url: "u", embedding: [1, 0, 0] },
    ];
    const result = selectBestVariant([0.9, 0.1, 0], only);
    expect(result!.label).toBe("base");
    expect(result!.confident).toBe(true);
  });

  it("returns null for an empty candidate list", () => {
    expect(selectBestVariant([1, 0, 0], [])).toBeNull();
  });

  it("is NOT confident on a near-tie (drives the base-image fallback)", () => {
    const nearTie: VariantEmbedding[] = [
      { label: "base", url: "a", embedding: [1, 0] },
      { label: "altArt", url: "b", embedding: [0.999, 0.0447] }, // almost identical
    ];
    const result = selectBestVariant([1, 0], nearTie);
    expect(result).not.toBeNull();
    // Top two scores are within MARGIN → low confidence → caller shows base art.
    expect(result!.confident).toBe(false);
  });

  it("is NOT confident when the top score is below the minimum (nothing matches)", () => {
    // Query orthogonal to everything → top cosine ~0, under MIN_CONFIDENCE.
    const result = selectBestVariant([0, 0, 0], candidates);
    expect(result!.confident).toBe(false);
  });
});
