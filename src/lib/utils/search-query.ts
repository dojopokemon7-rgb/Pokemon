/**
 * Search query normalizer (Epic A). Pure + client/server safe.
 *
 * Folds accents/case/punctuation so `mee-16`, `mee 16` and `MEE  16` parse
 * to the same identifier candidate, while PRESERVING leading zeros
 * (`OP01-064` stays, `016` is not `16`) — identifiers never fuzzy-match.
 */

export interface ParsedQuery {
  raw: string;
  /** Normalized full query (folded, single-spaced). */
  norm: string;
  tokens: string[];
  /** Lowercase `Card.externalId` candidates, e.g. `["mee-16"]`. */
  idCandidates: string[];
  /** Tokens that look like printed card numbers (`4`, `016`, `4/102`). */
  numberCandidates: string[];
  /** True for `<setcode> <digits>` shapes: typo tolerance is disabled. */
  identifierLike: boolean;
}

export function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, " ")
    .trim();
}

export function parseSearchQuery(raw: string): ParsedQuery {
  const norm = normalizeText(raw);
  const tokens = norm ? norm.split(" ") : [];
  const [a, b] = tokens;
  const idShape = tokens.length === 2 && /^\d+$/.test(b) && /[a-z]/.test(a) && !a.includes("/");
  const idCandidates = idShape ? [`${a}-${b}`] : [];
  // A set code either carries a digit (sv3, op01, base1) or is a short
  // letters-only code (mee, swsh); longer words ("pikachu 25") are names.
  const identifierLike = idShape && (/\d/.test(a) || /^[a-z]{2,5}$/.test(a));
  const numberCandidates = tokens.filter((t) => /^\d+(\/\d+)?$/.test(t));
  return { raw, norm, tokens, idCandidates, numberCandidates, identifierLike };
}
