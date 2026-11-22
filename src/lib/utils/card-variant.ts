/**
 * Printing/variant helpers for search (pure, client-safe — no Prisma/React).
 *
 * `Card.printing` holds the Scrydex `variants[].name` VERBATIM (see
 * card-number.ts baseVariantName / schema.prisma). The real vocabulary is
 * mixed-spelling: Pokémon prices/tests use camelCase ("normal", "holofoil",
 * "reverseHolofoil", "unlimitedShadowlessHolofoil", "firstEditionHolofoil"),
 * while comments/ids for One Piece show "alt-art" / "alt art" / "altArt".
 * The BASE printing is "normal" when Scrydex lists one, else the
 * alphabetically-first variant (so a holo-only card's base printing IS
 * "holofoil"). A null printing means "not stored (yet)": it is NEVER matched
 * by a variant filter and never labelled (RULE 2 — no fabricated variants).
 *
 * So the filter works on a SPELLING-INSENSITIVE KEY: lowercase words split on
 * camelCase / space / "-" / "_", with "1st" → "first"
 * ("reverseHolofoil" | "reverse holofoil" | "Reverse-Holofoil" → "reverse holofoil").
 */

/** Words of a raw printing / variant string (camelCase + separators split). */
function words(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => (w === "1st" ? "first" : w));
}

/** Canonical filter key for a raw printing/variant string ("" when empty). */
export function variantKey(raw: string): string {
  return words(raw).join(" ");
}

/** Sentinel for `?variant=any`: explicit "no variant filter" (disables text inference). */
export const VARIANT_ANY = "any";

/**
 * Every stored spelling a key can take, for case-INSENSITIVE equality in
 * Prisma (`printing: { equals, mode: "insensitive" }`): space / "-" / "_" /
 * no-separator (the last equals camelCase once case is ignored), each also
 * with a leading "first" written "1st".
 */
export function variantSpellings(key: string): string[] {
  const w = words(key);
  if (w.length === 0) return [];
  const forms = (ws: string[]) => [ws.join(" "), ws.join("-"), ws.join("_"), ws.join("")];
  const alt = w[0] === "first" ? forms(["1st", ...w.slice(1)]) : [];
  return [...new Set([...forms(w), ...alt])];
}

/** Friendly label for a key / raw value: "reverse holofoil" → "Reverse Holo". */
export function variantDisplayLabel(raw: string): string {
  const w = words(raw).map((x) => (x === "holofoil" ? "holo" : x === "first" ? "1st" : x));
  return w.map((x) => (/^\d/.test(x) ? x : x.charAt(0).toUpperCase() + x.slice(1))).join(" ");
}

// Free-text phrases → target key. Built from the vocabulary above. Single
// words that are ALSO type/tag/name words ("normal") are deliberately absent.
const PHRASES: Array<[string[], string]> = [
  [["reverse", "holofoil"], "reverse holofoil"],
  [["reverse", "holo"], "reverse holofoil"],
  [["reverse", "foil"], "reverse holofoil"],
  [["rev", "holo"], "reverse holofoil"],
  [["1st", "edition", "holofoil"], "first edition holofoil"],
  [["1st", "edition", "holo"], "first edition holofoil"],
  [["first", "edition", "holofoil"], "first edition holofoil"],
  [["first", "edition", "holo"], "first edition holofoil"],
  [["1st", "edition"], "first edition"],
  [["first", "edition"], "first edition"],
  [["1st", "ed"], "first edition"],
  [["alt", "art"], "alt art"],
  [["alternate", "art"], "alt art"],
  [["alt-art"], "alt art"],
  [["altart"], "alt art"],
  [["holofoil"], "holofoil"],
  [["holo"], "holofoil"],
  [["foil"], "foil"],
].sort((a, b) => b[0].length - a[0].length) as Array<[string[], string]>;

const stripPunct = (t: string) => t.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

export interface ParsedVariantQuery {
  /** Query with the variant phrase removed (== input, trimmed, when none). */
  query: string;
  /** Target key of the matched phrase, or null. */
  variant: string | null;
}

/**
 * Pull ONE variant phrase out of a free-text query. Rules (each unit-tested):
 *  - whole-token match only ("holographic", "foiled" never match);
 *  - the longest phrase wins ("reverse holo" is not "holo");
 *  - the remaining name query must be NON-EMPTY — a variant-only query
 *    ("holo", "alt art") stays a plain text search;
 *  - "holo"/"holofoil" next to the token "rare" is the RARITY name
 *    ("Rare Holo", "Holo Rare") and is left alone.
 * It does not know whether the variant exists; resolveInferredVariants does.
 * ponytail: a real card NAME containing a phrase would be stripped; none is
 * known in the catalog. Upgrade = skip when the unstripped query has a name hit.
 */
export function parseVariantFromQuery(query: string): ParsedVariantQuery {
  const original = query.trim();
  const raw = original.split(/\s+/).filter(Boolean);
  const toks = raw.map(stripPunct);
  for (const [phrase, variant] of PHRASES) {
    for (let i = 0; i + phrase.length <= toks.length; i++) {
      if (!phrase.every((p, j) => toks[i + j] === p)) continue;
      if (variant === "holofoil" && (toks[i - 1] === "rare" || toks[i + phrase.length] === "rare")) continue;
      const rest = [...raw.slice(0, i), ...raw.slice(i + phrase.length)].join(" ");
      // Variant-only query: stop here, a shorter phrase must not re-match its tail
      // ("reverse holo" must not become name "reverse" + holo).
      if (!rest) return { query: original, variant: null };
      return { query: rest, variant };
    }
  }
  return { query: original, variant: null };
}

/**
 * Map an inferred target onto the variants that REALLY exist for the game
 * (`available` = keys from the catalog). "first edition" also covers its
 * holo/shadowless siblings ("first edition holofoil", …) since "1st edition
 * charizard" is a holo card. Empty → nothing to infer (no printing data).
 */
export function resolveInferredVariants(target: string, available: string[]): string[] {
  return available.filter((v) => v === target || (target === "first edition" && v.startsWith("first edition ")));
}
