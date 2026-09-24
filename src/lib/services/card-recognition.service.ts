/**
 * Multi-signal card recognition engine (F-14).
 *
 * OCR text off a photographed card is noisy, but a card carries several
 * independent signals — its collector number, its set, and its name. Matching
 * on any one alone is fragile; combining them is what makes recognition
 * accurate. This module:
 *
 *   1. `parseOcr()`  — pulls structured signals out of the raw OCR text:
 *        - card number   (e.g. "4/102", "OP05-119", "SV3-224")
 *        - set keywords  (matched against a caller-supplied set-name list)
 *        - candidate name lines (largest-font heuristic ≈ first text lines)
 *   2. `scoreCards()` — scores every catalog card against those signals:
 *        - normalized number match → +50
 *        - set match               → +20
 *        - name fuzzy similarity   → +30 * similarity
 *      and returns the TOP N sorted by score, with a 0–100 confidence %.
 *
 * Pure + dependency-free (reuses fuzzy-match's similarity). The DB layer
 * (the recognize route) supplies the candidate pool and set list; this file
 * never touches Prisma, so it's unit-testable in isolation.
 */

import { similarity } from "@/lib/utils/fuzzy-match";

// ── Signal weights (Task 3 §2). Exported so scoring can be tuned later from
// ── ScanFeedback data without hunting for magic numbers.
export const WEIGHTS = {
  number: 50,
  set: 20,
  name: 30, // multiplied by name similarity (0..1)
} as const;

/** Max score a card can earn — used to normalize into a 0..1 confidence. */
export const MAX_SCORE = WEIGHTS.number + WEIGHTS.set + WEIGHTS.name;

// Ignore name similarity below this floor. Two reasons: Levenshtein
// similarity is never exactly 0 for non-empty strings, and short OCR tokens
// can coincidentally overlap a card name ("noise" vs "blastoise" ≈ 0.55).
// Genuine name matches — even with a few OCR glyph errors — sit at 0.7+, so a
// 0.6 floor keeps real matches while rejecting coincidental partial overlaps.
const MIN_NAME_SIM = 0.6;

export interface ParsedOcr {
  /** Normalized collector number if one was found (e.g. "4/102", "op05-119"). */
  number: string | null;
  /** Lowercased name-candidate lines, largest-font-first heuristic. */
  nameLines: string[];
  /** The full lowercased OCR text (for whole-string name fallback). */
  raw: string;
}

export interface CatalogCard {
  id: string; // externalId
  name: string;
  number?: string | null;
  set: string; // set name
  imageUrl: string;
}

export interface ScoredCandidate extends CatalogCard {
  /** Raw additive score (0..MAX_SCORE). */
  score: number;
  /** Confidence in [0,1] = score / MAX_SCORE, clamped. */
  confidence: number;
}

// Pokémon-style "4/102" (with optional spaces around the slash).
const POKEMON_NUMBER_RE = /(\d{1,3})\s*\/\s*(\d{1,3})/;
// Bandai/modern set-coded serials: OP05-119, ST01-012, SV3-224, EB01-001, PRB01-001.
// Accepts hyphen or en-dash between the set code and the number.
const SET_CODE_RE = /\b((?:SV|OP|ST|EB|PRB)\d{1,3})\s*[-–]\s*(\d{1,3})\b/i;

/** Collapses a number to a comparable canonical form: lowercase, no spaces,
 *  en-dash → hyphen. "OP05 – 119" → "op05-119"; "4 / 102" → "4/102". */
export function normalizeNumber(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, "").replace(/–/g, "-");
}

/**
 * Extracts the structured signals from raw OCR text.
 *
 * Name-line heuristic: real card names sit at the top in the largest font.
 * OCR returns text top-to-bottom, so the FIRST lines that are mostly letters
 * (not a number/HP/stage/energy-cost line) are the best name candidates. We
 * keep the first few such lines rather than guessing exactly one.
 */
export function parseOcr(text: string): ParsedOcr {
  const raw = text.toLowerCase();

  const setCode = SET_CODE_RE.exec(text);
  const pkmnNumber = POKEMON_NUMBER_RE.exec(text);
  const number = setCode
    ? normalizeNumber(`${setCode[1]}-${setCode[2]}`)
    : pkmnNumber
      ? normalizeNumber(`${pkmnNumber[1]}/${pkmnNumber[2]}`)
      : null;

  // Non-numeric, non-trivial lines become name candidates, in OCR order
  // (top-of-card first ≈ largest font first).
  const nameLines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => {
      if (l.length < 2) return false;
      // Skip lines that are mostly digits/symbols (numbers, HP, energy).
      const letters = (l.match(/[a-z]/gi) ?? []).length;
      return letters >= 2 && letters / l.length >= 0.5;
    })
    .map((l) => l.toLowerCase())
    .slice(0, 4);

  return { number, nameLines, raw };
}

/** Best name similarity: the candidate name vs. each parsed name line, the
 *  whole OCR blob, AND each same-length word window of the OCR text. OCR
 *  usually returns the name embedded in surrounding junk ("CHARIZARD 120 HP
 *  4/102"), so a sliding window sized to the card's word count recovers the
 *  clean name match. We take the max across all of these. */
function bestNameSimilarity(parsed: ParsedOcr, cardName: string): number {
  const name = cardName.toLowerCase();
  let best = similarity(parsed.raw, name);
  for (const line of parsed.nameLines) {
    best = Math.max(best, similarity(line, name));
  }
  // Slide a window of `nameWordCount` words across the OCR text.
  const nameWords = name.split(/\s+/).filter(Boolean);
  const ocrWords = parsed.raw.split(/\s+/).filter(Boolean);
  const win = nameWords.length;
  for (let i = 0; win > 0 && i + win <= ocrWords.length; i++) {
    best = Math.max(best, similarity(ocrWords.slice(i, i + win).join(" "), name));
  }
  return best;
}

/** True if the OCR text mentions the card's set (by name). Split into words so
 *  a multi-word set name ("Obsidian Flames") matches even amid OCR noise. */
function setMatches(parsed: ParsedOcr, setName: string): boolean {
  const set = setName.trim().toLowerCase();
  if (!set || set === "unknown set") return false;
  if (parsed.raw.includes(set)) return true;
  // Every non-trivial word of the set name appears somewhere in the OCR text.
  const words = set.split(/\s+/).filter((w) => w.length >= 3);
  return words.length > 0 && words.every((w) => parsed.raw.includes(w));
}

/**
 * Scores a pool of catalog cards against parsed OCR signals and returns the
 * top `topN` sorted by score, each with a confidence %.
 *
 * A card with zero name similarity, no number match, and no set match scores
 * 0 and is dropped — so a pool with no real match returns [] (the caller
 * shows "not recognized").
 */
export function scoreCards(
  parsed: ParsedOcr,
  pool: CatalogCard[],
  topN = 5
): ScoredCandidate[] {
  const scored = pool.map((card): ScoredCandidate => {
    let score = 0;

    // +50 exact/normalized number match.
    if (parsed.number && card.number) {
      if (normalizeNumber(card.number) === parsed.number) score += WEIGHTS.number;
    }

    // +20 set match.
    if (setMatches(parsed, card.set)) score += WEIGHTS.set;

    // +30 * name similarity, but only once it clears the noise floor —
    // otherwise every card earns a trace of name score off random OCR text.
    const nameSim = bestNameSimilarity(parsed, card.name);
    if (nameSim >= MIN_NAME_SIM) score += WEIGHTS.name * nameSim;

    return {
      ...card,
      score,
      confidence: Math.max(0, Math.min(1, score / MAX_SCORE)),
    };
  });

  return scored
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

/** Convenience: parse + score in one call. */
export function recognize(
  ocrText: string,
  pool: CatalogCard[],
  topN = 5
): ScoredCandidate[] {
  return scoreCards(parseOcr(ocrText), pool, topN);
}
