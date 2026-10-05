/**
 * Search relevance ranker (Epic A). Pure + deterministic.
 *
 * Tier order (high → low): exact externalId > exact number + set code >
 * exact name > name prefix > every token matches (name > set > rarity/tags)
 * > partial token match. Ties break by `externalId` asc so ordering is stable.
 * Typo tolerance applies ONLY to names / set names and never to identifier
 * queries (`identifierLike`), so `mee-17` can never return `mee-16`.
 *
 * ponytail: JS scoring over a bounded candidate pool (the route fetches
 * <= 300-600 rows); very common prefixes can miss true matches outside the
 * pool. Upgrade path: the env-flagged Typesense adapter
 * (card-search-index.service.ts).
 */

import { levenshtein } from "./fuzzy-match";
import { normalizeText, type ParsedQuery } from "./search-query";

export interface RankableCard {
  externalId: string;
  name: string;
  number?: string | null;
  setName?: string | null;
  rarity?: string | null;
  tags?: string[] | null;
}

/** 0 edits below 4 chars, 1 for 4-7, 2 for 8+. */
export function maxTypoDistance(len: number): number {
  return len < 4 ? 0 : len < 8 ? 1 : 2;
}

const ALL_TOKENS_BONUS = 400;

/** "op01-064" → "op01"; "mee-16" → "mee" (set code is the id minus its last segment). */
const setCodeOf = (externalId: string) => externalId.toLowerCase().replace(/-[^-]*$/, "");

/** Printed number key: last word, left of "/" ("4/102" → "4", "OP01-064" → "064"). */
function numberKey(number?: string | null): string {
  const words = normalizeText(number ?? "").split(" ");
  return (words[words.length - 1] ?? "").split("/")[0];
}

function wordScore(token: string, words: string[], typo: boolean, exact: number, prefix: number, fuzzy: number): number {
  let best = 0;
  for (const w of words) {
    if (w === token) return exact;
    if (w.startsWith(token)) best = Math.max(best, prefix);
    else if (typo && !/\d/.test(token)) {
      const d = maxTypoDistance(token.length);
      if (d > 0 && Math.abs(w.length - token.length) <= d && levenshtein(token, w) <= d) best = Math.max(best, fuzzy);
    }
  }
  return best;
}

interface Scored {
  score: number;
  nameHit: boolean;
}

function scoreCard(p: ParsedQuery, card: RankableCard): Scored {
  if (!p.norm) return { score: 0, nameHit: false };
  const id = card.externalId.toLowerCase();
  if (p.idCandidates.includes(id)) return { score: 1000, nameHit: false };
  const code = setCodeOf(card.externalId);
  const nKey = numberKey(card.number);
  const [idSet, idNum] = (p.idCandidates[0] ?? "").split("-");
  if (p.idCandidates.length && idSet === code && idNum === nKey) return { score: 900, nameHit: false };

  const nameN = normalizeText(card.name);
  if (nameN === p.norm) return { score: 800, nameHit: true };
  if (nameN.startsWith(p.norm)) return { score: 700, nameHit: true };

  const nameWords = nameN.split(" ");
  const setWords = normalizeText(card.setName ?? "").split(" ");
  const rarityWords = normalizeText(card.rarity ?? "").split(" ");
  const fullNumber = normalizeText(card.number ?? "");
  const typo = !p.identifierLike;
  let sum = 0;
  let matched = 0;
  let nameHit = false;
  for (const t of p.tokens) {
    const name = wordScore(t, nameWords, typo, 80, 60, 40);
    if (name) nameHit = true;
    const s = Math.max(
      name,
      t === code ? 70 : 0,
      t === nKey || t === fullNumber ? 50 : 0,
      wordScore(t, setWords, typo, 30, 25, 20),
      wordScore(t, rarityWords, false, 20, 20, 0),
      (card.tags ?? []).includes(t) ? 15 : 0
    );
    if (s) matched++;
    sum += s;
  }
  const all = matched === p.tokens.length;
  // Identifier-like queries need EVERY token to match: no partial fallback.
  if (!all && (p.identifierLike || matched === 0)) return { score: 0, nameHit: false };
  return { score: (all ? ALL_TOKENS_BONUS : 0) + sum, nameHit };
}

/** Returns matching cards best-first; non-matches are dropped. */
export function rankCards<T extends RankableCard>(p: ParsedQuery, cards: T[]): T[] {
  return cards
    .map((card) => ({ card, score: scoreCard(p, card).score }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (a.card.externalId < b.card.externalId ? -1 : a.card.externalId > b.card.externalId ? 1 : 0))
    .map((x) => x.card);
}

/** True when any card matches on its NAME (exact/prefix/word/typo). */
export function hasNameHit(p: ParsedQuery, cards: RankableCard[]): boolean {
  return cards.some((c) => scoreCard(p, c).nameHit);
}
