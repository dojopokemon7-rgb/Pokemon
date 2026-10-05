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
 *      and returns the TOP N sorted by score, with a 0–1 confidence.
 *
 * Pure + dependency-free (reuses fuzzy-match's similarity). The DB layer
 * (the recognize route) supplies the candidate pool and set list; this file
 * never touches Prisma, so it's unit-testable in isolation.
 *
 * ── Accuracy note (honesty constraint, F-14) ───────────────────────────────
 * The unit tests prove the LOGIC on representative OCR strings — number
 * parsing, confidence, and ranking. They do NOT (and cannot) prove real-world
 * CAMERA accuracy: a physical scan carries lens blur, glare, perspective, and
 * provider-OCR quirks that only real-device testing exposes. Final accuracy
 * validation requires scanning physical cards on a device (the user's step).
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
  /** Confidence in [0,1] — see computeConfidence() for the formula. */
  confidence: number;
  /** True when this card's normalized number equals the parsed OCR number.
   *  Exposed because it's the single strongest signal and drives tie-breaks. */
  numberMatch: boolean;
  /** Best name similarity (0..1), used for ranking tie-breaks. */
  nameSim: number;
}

// Real cards print collector numbers in several shapes. Rather than one
// unreadable mega-regex, each format is its own commented pattern and
// parseOcr() tries them in priority order (most specific first). All feed
// through normalizeNumber() so a parsed OCR number and a stored card.number
// collapse to the same canonical string.

// Lettered fraction: Trainer Gallery "TG01/TG30", Galarian Gallery "GG01/GG70".
// The prefix repeats on both sides; we keep only the first side's "TG01" form
// (that's what card.number stores) — the "/TG30" denominator is set size noise.
const LETTER_FRACTION_RE = /\b([A-Z]{1,3}\d{1,3})\s*\/\s*[A-Z]{1,3}\d{1,3}\b/i;
// Pokémon-style "4/102" (with optional spaces around the slash).
const POKEMON_NUMBER_RE = /(\d{1,3})\s*\/\s*(\d{1,3})/;
// Bandai/modern set-coded serials: OP05-119, ST01-012, SV3-224, EB01-001,
// PRB01-001. Accepts hyphen or en-dash between the set code and the number.
const SET_CODE_RE = /\b((?:SV|OP|ST|EB|PRB)\d{1,3})\s*[-–]\s*(\d{1,3})\b/i;
// Hyphenated promo codes: SVP-001, SWSH-284, P-001. Letter prefix, separator,
// digits. The separator is optional on the printed card (see JOINED_PROMO_RE),
// so this handles the "with separator" reading.
const HYPHEN_PROMO_RE = /\b((?:SVP|SWSH|P)\s*[-–]\s*\d{1,3})\b/i;
// Joined promo codes: SWSH284, SVP001 — the prefix glues straight onto the
// digits (how Sword&Shield / Scarlet&Violet black-star promos are printed).
// OCR sometimes splits them with a stray space ("SWSH 284"), so an optional
// space is tolerated and normalizeNumber() strips it back out. Listed after
// HYPHEN_PROMO_RE so a hyphenated form is read as such first.
const JOINED_PROMO_RE = /\b((?:SWSH|SVP|P)\s*\d{1,4})\b/i;

/** Collapses a number to a comparable canonical form so OCR output and the
 *  stored card.number compare equal:
 *    - lowercase, strip ALL internal whitespace
 *    - en-dash (–) → hyphen (-)
 *    - drop a hyphen that merely separates a letter prefix from its digits
 *      ("swsh-284" → "swsh284", "svp-001" → "svp001") so the hyphenated and
 *      joined promo spellings canonicalize identically. A hyphen BETWEEN two
 *      digit groups ("op05-119") is a real set-serial separator and is kept.
 *  "OP05 – 119" → "op05-119"; "4 / 102" → "4/102"; "SWSH 284" → "swsh284". */
export function normalizeNumber(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/–/g, "-")
    .replace(/([a-z])-(\d)/g, "$1$2"); // letter-prefix hyphen is cosmetic
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

  // Try each number shape in priority order: most specific first so an
  // ambiguous string resolves to its richest reading. The first hit wins.
  const letterFraction = LETTER_FRACTION_RE.exec(text); // TG01/TG30, GG01/GG70
  const setCode = SET_CODE_RE.exec(text); //                OP05-119, SV3-224
  const hyphenPromo = HYPHEN_PROMO_RE.exec(text); //        SVP-001, SWSH-284
  const joinedPromo = JOINED_PROMO_RE.exec(text); //        SWSH284, SVP001
  const pkmnNumber = POKEMON_NUMBER_RE.exec(text); //       4/102
  const number = letterFraction
    ? normalizeNumber(letterFraction[1]) // keep the "TG01" side only
    : setCode
      ? normalizeNumber(`${setCode[1]}-${setCode[2]}`)
      : hyphenPromo
        ? normalizeNumber(hyphenPromo[1])
        : joinedPromo
          ? normalizeNumber(joinedPromo[1])
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
 * Honest confidence for the top candidate, in [0,1].
 *
 * The old formula was `score / MAX_SCORE` (always ÷100). That is DIShonest in
 * two directions:
 *   - It penalizes a card for signals the OCR never produced. A card matched
 *     perfectly on NUMBER + NAME but with no set text to match caps at
 *     (50+30)/100 = 0.80 — reading as "unsure" when it's unambiguously right.
 *   - It ignores ambiguity. Two near-tied candidates both read ~0.80 even
 *     though the scan can't actually tell them apart.
 *
 * The honest formula fixes both:
 *   1. ACHIEVABILITY — divide by the weight of signals that COULD match given
 *      the OCR, not the fixed 100. If no number was parsed, the number weight
 *      is not in the denominator; if no set text was parseable, neither is the
 *      set weight. Name is always achievable (there's always text). So a
 *      number+name match with no set parses as 80/80 = 1.0 before step 2.
 *   2. SEPARATION — multiply by a margin factor from the gap to the 2nd
 *      candidate: a clear winner keeps its score; a near-tie is pulled down
 *      toward 0.5·base. This is what makes two look-alikes read LOWER.
 *
 * Never fabricates a high score for a weak match: a weak top candidate has a
 * low `base`, and step 2 only ever lowers it.
 */
function computeConfidence(
  top: ScoredCandidate,
  runnerUp: ScoredCandidate | undefined,
  achievable: number
): number {
  if (achievable <= 0 || top.score <= 0) return 0;
  const base = Math.min(1, top.score / achievable);

  // Margin ∈ [0.5,1]. A runner-up scoring up to HALF the top score is normal
  // (e.g. a set-only partial match) and costs nothing — margin stays 1. Only
  // once the runner-up exceeds half the top score does ambiguity bite, ramping
  // linearly to 0.5 at a dead tie. This keeps a clear winner honest-high while
  // pulling two genuine look-alikes down.
  let margin = 1;
  if (runnerUp && runnerUp.score > 0) {
    const ratio = runnerUp.score / top.score; // (0,1]
    margin = 1 - 0.5 * Math.max(0, Math.min(1, (ratio - 0.5) / 0.5));
  }
  return Math.max(0, Math.min(1, base * margin));
}

/**
 * Scores a pool of catalog cards against parsed OCR signals and returns the
 * top `topN` ranked best-first, each with an honest confidence (see
 * computeConfidence).
 *
 * Ranking is score-descending, then a DETERMINISTIC tie-break so equal-score
 * results never flip-flop between scans:
 *   1. higher score
 *   2. exact normalized NUMBER match wins (a number near-uniquely identifies a
 *      card within a set, so a number hit outranks a name-only match)
 *   3. higher name similarity
 *   4. stable by id (lexicographic) as the final deterministic fallback
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
    const numberMatch = Boolean(
      parsed.number && card.number && normalizeNumber(card.number) === parsed.number
    );
    if (numberMatch) score += WEIGHTS.number;

    // +20 set match.
    if (setMatches(parsed, card.set)) score += WEIGHTS.set;

    // +30 * name similarity, but only once it clears the noise floor —
    // otherwise every card earns a trace of name score off random OCR text.
    const nameSim = bestNameSimilarity(parsed, card.name);
    if (nameSim >= MIN_NAME_SIM) score += WEIGHTS.name * nameSim;

    return { ...card, score, confidence: 0, numberMatch, nameSim };
  });

  const ranked = scored
    .filter((c) => c.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Deterministic tie-break (documented above).
      if (a.numberMatch !== b.numberMatch) return a.numberMatch ? -1 : 1;
      if (b.nameSim !== a.nameSim) return b.nameSim - a.nameSim;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, topN);

  // Confidence is a property of the WHOLE result set (achievability + margin),
  // so it's computed after ranking, from the signals the OCR actually carried.
  // The set weight counts toward "achievable" only if the OCR carried set text
  // that actually matched some candidate — if nothing matched a set, we can't
  // know a set was even visible, so we don't penalize every card for its
  // absence. (A parsed number is self-evidently present/absent.)
  const setAchievable = scored.some((c) => setMatches(parsed, c.set));
  const achievable =
    (parsed.number ? WEIGHTS.number : 0) +
    (setAchievable ? WEIGHTS.set : 0) +
    WEIGHTS.name;
  for (let i = 0; i < ranked.length; i++) {
    ranked[i].confidence = computeConfidence(ranked[i], ranked[i + 1], achievable);
  }
  return ranked;
}

/** Convenience: parse + score in one call. */
export function recognize(
  ocrText: string,
  pool: CatalogCard[],
  topN = 5
): ScoredCandidate[] {
  return scoreCards(parseOcr(ocrText), pool, topN);
}
