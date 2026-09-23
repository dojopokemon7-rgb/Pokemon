/**
 * Fuzzy string matching for card recognition (F-14).
 *
 * OCR output is noisy (mis-read glyphs, extra tokens, casing), so we match
 * the extracted text against catalog card names with a similarity score
 * rather than exact equality. Pure + dependency-free.
 */

/** Levenshtein edit distance between two strings. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // Single-row DP (O(n) space).
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Normalized similarity in [0,1]: 1 = identical, 0 = completely different. */
export function similarity(a: string, b: string): number {
  const s1 = a.trim().toLowerCase();
  const s2 = b.trim().toLowerCase();
  if (!s1 && !s2) return 1;
  if (!s1 || !s2) return 0;
  const dist = levenshtein(s1, s2);
  return 1 - dist / Math.max(s1.length, s2.length);
}

/**
 * Scores a candidate name against noisy OCR text. Returns the best of:
 *   - whole-string similarity, and
 *   - the best similarity of the candidate against any single OCR line/word
 *     window (OCR often includes the name plus surrounding junk).
 * This lets "Charizard" score high even when OCR returns
 * "CHARIZARD 150 HP STAGE 2".
 */
export function scoreCandidate(ocrText: string, candidateName: string): number {
  const whole = similarity(ocrText, candidateName);

  // Compare against each OCR token-window sized to the candidate's word count.
  const candWords = candidateName.trim().split(/\s+/);
  const ocrWords = ocrText.trim().split(/\s+/).filter(Boolean);
  let best = whole;
  const win = candWords.length;
  for (let i = 0; i + win <= ocrWords.length; i++) {
    const window = ocrWords.slice(i, i + win).join(" ");
    best = Math.max(best, similarity(window, candidateName));
  }
  // Also test each single OCR line (split on newlines) against the name.
  for (const line of ocrText.split(/\n+/)) {
    if (line.trim()) best = Math.max(best, similarity(line, candidateName));
  }
  return best;
}
