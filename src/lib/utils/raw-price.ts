/**
 * Shared RAW-price derivation (pure, client-safe — no Prisma/React).
 *
 * ONE rule for every surface (card details, Explore search, trending, graded
 * lookup, Scrydex snapshot): Raw = Near Mint if present, else the next
 * available raw condition LP -> MP -> HP -> DM. Graded rows are NEVER a
 * fallback; nothing raw => null => the UI renders "—".
 *
 * WHY filter on `type`, not `condition`: LEGACY graded CurrentPrice rows were
 * written with condition "NM" (~300k rows), so `condition === "NM"` alone
 * matches graded rows (e.g. a PSA 10 at $83k) in arbitrary DB order. The
 * Scrydex code for damaged is "DM" (NOT "DMG").
 */

export const RAW_CONDITION_ORDER = ["NM", "LP", "MP", "HP", "DM"] as const;

export interface PriceRowLike {
  variant?: string | null;
  type?: string | null;
  condition?: string | null;
  company?: string | null;
  grade?: string | null;
  priceMarket?: number | null;
  priceLow?: number | null;
}

// Preferred variant order for the default pick; unknown variants rank after
// these, then alphabetically — deterministic regardless of DB row order.
const VARIANT_PRIORITY = [
  "normal",
  "holofoil",
  "reverseHolofoil",
  "unlimitedHolofoil",
  "unlimited",
  "firstEditionHolofoil",
  "firstEdition",
];

/** type === "raw" only. Legacy rows with no `type` count as raw only when they carry no company/grade. */
export function isRawRow(r: PriceRowLike): boolean {
  if (r.type == null) return r.company == null && r.grade == null;
  return r.type === "raw";
}

/** priceMarket ?? priceLow ?? null (never coerced to 0). */
export function rowPrice(r: PriceRowLike): number | null {
  return r.priceMarket ?? r.priceLow ?? null;
}

function variantRank(v: string): number {
  const i = VARIANT_PRIORITY.indexOf(v);
  return i === -1 ? VARIANT_PRIORITY.length : i;
}

const cmpVariant = (a: string, b: string) => variantRank(a) - variantRank(b) || a.localeCompare(b);

export interface BestRaw { price: number; condition: string; variant: string }

/**
 * Best raw row: lowest RAW_CONDITION_ORDER index present (unknown conditions are
 * ignored). Optional `variant` restricts to that variant; without it ties on
 * condition resolve by variant priority so the result is order-independent.
 */
export function pickBestRaw(rows: PriceRowLike[], variant?: string | null): BestRaw | null {
  let best: BestRaw | null = null;
  let bestRank = Infinity;
  for (const r of rows) {
    if (!isRawRow(r)) continue;
    if (variant != null && (r.variant ?? "normal") !== variant) continue;
    const rank = (RAW_CONDITION_ORDER as readonly string[]).indexOf(r.condition ?? "");
    if (rank === -1) continue;
    const price = rowPrice(r);
    if (price == null) continue;
    const v = r.variant ?? "normal";
    if (rank < bestRank || (rank === bestRank && best && cmpVariant(v, best.variant) < 0)) {
      best = { price, condition: r.condition as string, variant: v };
      bestRank = rank;
    }
  }
  return best;
}

/** Distinct variants having ANY priced row (raw or graded), deterministic order. */
export function listVariants(rows: PriceRowLike[]): string[] {
  const set = new Set<string>();
  for (const r of rows) if (rowPrice(r) != null) set.add(r.variant ?? "normal");
  return [...set].sort(cmpVariant);
}

/** Variant with the best raw (condition rank, then variant priority); none raw -> first listed variant. */
export function pickDefaultVariant(rows: PriceRowLike[]): string | null {
  const best = pickBestRaw(rows);
  return best ? best.variant : (listVariants(rows)[0] ?? null);
}

/** "firstEditionShadowlessHolofoil" -> "First Edition Shadowless Holofoil". */
export function variantLabel(v: string): string {
  const spaced = v.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Headline raw price for a card's rows (default variant, NM else next available). */
export function pickHeadlineRaw(rows: PriceRowLike[]): number | null {
  return pickBestRaw(rows, pickDefaultVariant(rows))?.price ?? null;
}

// Grading companies recognised in a free-text condition label. Same vocabulary
// as AddCardSheet's KNOWN_GRADERS (the source of the stored "<CO> <grade>"
// condition) so the server parses exactly what the client persisted — no
// parallel picker (ponytail: reuse, don't duplicate).
const GRADER_COMPANIES = ["PSA", "BGS", "CGC", "SGC", "TAG", "ACE", "AGS"] as const;

/**
 * Parse a stored graded condition ("PSA 10", "CGC 9.5") into { company, grade }.
 * Mirrors AddCardSheet.parseGraded: company = first KNOWN grader matched on a
 * word boundary (case-insensitive, uppercased); grade = first `\d+(?:\.\d+)?`.
 * Returns null for a raw/unparseable condition (e.g. "NM", null, "") — the
 * caller then keeps the raw path (RULE 2: never fabricate a graded number).
 */
export function parseGradedCondition(
  condition: string | null | undefined
): { company: string; grade: string } | null {
  if (!condition) return null;
  const company = GRADER_COMPANIES.find((g) => new RegExp(`\\b${g}\\b`, "i").test(condition));
  if (!company) return null;
  const grade = condition.match(/\d+(?:\.\d+)?/)?.[0];
  if (!grade) return null;
  return { company, grade };
}

/**
 * Pick the graded market price for a (company, grade) from a card's CurrentPrice
 * rows — the SAME selection the `/graded` route does inline: filter
 * `type==="graded" && company && grade && priceMarket != null`, prefer the given
 * `variant` (else the card's default variant), else the first variant in a
 * deterministic order. Returns `rowPrice(match)` or null when no graded row
 * matches (caller falls back to raw — never fabricates).
 */
export function pickGradedFromRows(
  rows: PriceRowLike[],
  company: string,
  grade: string,
  variant?: string | null
): number | null {
  const matches = rows.filter(
    (r) => r.type === "graded" && r.company === company && r.grade === grade && r.priceMarket != null
  );
  if (matches.length === 0) return null;
  const wantVariant = variant ?? pickDefaultVariant(rows);
  const chosen =
    matches.find((r) => (r.variant ?? "normal") === wantVariant) ??
    [...matches].sort((a, b) => (a.variant ?? "normal").localeCompare(b.variant ?? "normal"))[0];
  return rowPrice(chosen);
}
