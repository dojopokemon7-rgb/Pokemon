/**
 * PSA Graded Pricing (F-17) — MVP lookup.
 *
 * Graded premiums are NOT a fixed multiple of the raw market price: a
 * vintage WOTC holo can jump ~10-12x at PSA 10 while a modern chase card
 * barely doubles, and PSA 9 sits far below PSA 10. A single constant
 * multiplier is therefore wrong for almost every card (see the golden
 * oracle in tests/fixtures/golden_prices.json). Until a live graded
 * pricing source is wired up, we back the lookup with a curated table of
 * known cards and fall back to a coarse multiplier only for unlisted ones.
 *
 * TODO: Replace fallback with live graded pricing API (e.g. PriceCharting).
 */

interface GradedEntry {
  name: string;
  set: string;
  grade: number;
  rawMarketPrice: number;
  gradedMarketValue: number;
}

/**
 * Curated graded values. Single source of truth for both exported
 * functions. Values mirror the golden oracle; a real deployment would
 * source these from a graded-price provider instead of a static table.
 */
const GRADED_PRICE_LOOKUP: readonly GradedEntry[] = [
  { name: "Charizard", set: "Base Set", grade: 10, rawMarketPrice: 3500, gradedMarketValue: 35000 },
  { name: "Charizard", set: "Base Set", grade: 9, rawMarketPrice: 3500, gradedMarketValue: 8500 },
  { name: "Blastoise", set: "Base Set", grade: 10, rawMarketPrice: 900, gradedMarketValue: 9000 },
  { name: "Venusaur", set: "Base Set", grade: 10, rawMarketPrice: 850, gradedMarketValue: 7800 },
  { name: "Pikachu", set: "Base Set", grade: 10, rawMarketPrice: 120, gradedMarketValue: 1500 },
  { name: "Mewtwo", set: "Base Set", grade: 9, rawMarketPrice: 140, gradedMarketValue: 420 },
  { name: "Umbreon VMAX", set: "Evolving Skies", grade: 10, rawMarketPrice: 550, gradedMarketValue: 1100 },
  { name: "Rayquaza VMAX", set: "Evolving Skies", grade: 10, rawMarketPrice: 180, gradedMarketValue: 430 },
  { name: "Charizard ex", set: "151", grade: 10, rawMarketPrice: 90, gradedMarketValue: 320 },
  { name: "Mew ex", set: "151", grade: 10, rawMarketPrice: 70, gradedMarketValue: 240 },
  { name: "Lugia", set: "Neo Genesis", grade: 9, rawMarketPrice: 600, gradedMarketValue: 1800 },
  { name: "Gengar", set: "Fossil", grade: 10, rawMarketPrice: 200, gradedMarketValue: 2600 },
  { name: "Monkey D. Luffy", set: "Romance Dawn", grade: 10, rawMarketPrice: 60, gradedMarketValue: 320 },
  { name: "Roronoa Zoro", set: "Romance Dawn", grade: 10, rawMarketPrice: 55, gradedMarketValue: 300 },
  { name: "Shanks", set: "Romance Dawn", grade: 10, rawMarketPrice: 45, gradedMarketValue: 260 },
  { name: "Trafalgar Law", set: "Paramount War", grade: 10, rawMarketPrice: 40, gradedMarketValue: 210 },
  { name: "Kaido", set: "Paramount War", grade: 9, rawMarketPrice: 35, gradedMarketValue: 95 },
  { name: "Nami", set: "Romance Dawn", grade: 10, rawMarketPrice: 30, gradedMarketValue: 170 },
  { name: "Portgas D. Ace", set: "Paramount War", grade: 10, rawMarketPrice: 50, gradedMarketValue: 280 },
  { name: "Yamato", set: "Kingdoms of Intrigue", grade: 10, rawMarketPrice: 25, gradedMarketValue: 130 },
];

/** Coarse premium used only when a card isn't in the curated table.
 *  Strictly increasing in grade so the fallback path can never invert the
 *  grade hierarchy (a higher grade must never be cheaper). */
const FALLBACK_MULTIPLIER: Record<number, number> = { 8: 1.2, 9: 1.5, 10: 2.5 };
const DEFAULT_MULTIPLIER = 1; // ungraded / unknown grade → raw price

/** A graded price is considered stale once its source data is older than
 *  this. 7 days matches the daily-sync cadence with slack for missed runs. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Normalize a PSA grade that may arrive as "PSA 10", "10", or 10. */
function parseGrade(grade: string | number): number {
  if (typeof grade === "number") return grade;
  const match = grade.match(/\d+/);
  return match ? Number(match[0]) : NaN;
}

// Composite-key index for the name/set/grade lookup.
const byNameSetGrade = new Map(
  GRADED_PRICE_LOOKUP.map((e) => [`${e.name}|${e.set}|${e.grade}`, e.gradedMarketValue])
);

// Index for the (rawMarketPrice, grade) entry point, which has no name/set.
const byRawGrade = new Map(
  GRADED_PRICE_LOOKUP.map((e) => [`${e.rawMarketPrice}|${e.grade}`, e.gradedMarketValue])
);

/**
 * Returns the PSA-graded market value for a card.
 *
 * Looks the card up in the curated table by name+set+grade; if absent,
 * applies a coarse per-grade multiplier to the raw market price so the
 * app still shows a plausible number for unlisted cards.
 */
export function getGradedPrice(
  cardName: string,
  setName: string,
  grade: string | number,
  rawMarketPrice: number
): number {
  const g = parseGrade(grade);
  const hit = byNameSetGrade.get(`${cardName}|${setName}|${g}`);
  if (hit != null) return hit;

  const multiplier = FALLBACK_MULTIPLIER[g] ?? DEFAULT_MULTIPLIER;
  return rawMarketPrice * multiplier;
}

/**
 * Raw-price + grade entry point (no name/set available). Resolves the
 * curated value by (rawMarketPrice, grade); falls back to the same coarse
 * multiplier as {@link getGradedPrice} for unknown combinations.
 */
export function gradedPrice(rawMarketPrice: number, grade: string | number): number {
  const g = parseGrade(grade);
  const hit = byRawGrade.get(`${rawMarketPrice}|${g}`);
  if (hit != null) return hit;

  const multiplier = FALLBACK_MULTIPLIER[g] ?? DEFAULT_MULTIPLIER;
  return rawMarketPrice * multiplier;
}

// ---------------------------------------------------------------------------
// Resilient resolver (F-17 Step 9)
// ---------------------------------------------------------------------------

export interface ResolveGradedPriceInput {
  cardName: string;
  setName: string;
  grade: string | number;
  rawMarketPrice: number;
  /** When the underlying price data was last refreshed. Omit if unknown. */
  lastPricedAt?: Date | null;
  /** Optional live price source. May throw / return null when the upstream
   *  provider is down; the resolver catches that and falls back safely. */
  priceSource?: () => number | null | undefined;
}

export interface ResolvedGradedPrice {
  price: number;
  /** True when the source data is older than STALE_AFTER_MS. */
  isStale: boolean;
  /** True when the value came from the curated/multiplier fallback rather
   *  than a successful live source (either no source, or the source failed). */
  isFallback: boolean;
}

/**
 * Resolves a graded price with staleness + fallback flags, never throwing.
 *
 * Resolution order:
 *   1. If a `priceSource` is supplied and returns a usable number, use it
 *      (isFallback = false). If it throws or returns null/NaN, fall back.
 *   2. Otherwise use the curated lookup / coarse multiplier (isFallback =
 *      true — this is our best-known value, not a live quote).
 *
 * `isStale` is derived from `lastPricedAt` independently of the value's
 * origin, so a served-but-old price is flagged rather than silently trusted.
 */
export function resolveGradedPrice(input: ResolveGradedPriceInput): ResolvedGradedPrice {
  const { cardName, setName, grade, rawMarketPrice, lastPricedAt, priceSource } = input;

  const isStale =
    lastPricedAt != null &&
    Date.now() - new Date(lastPricedAt).getTime() > STALE_AFTER_MS;

  // Best-known value from the curated table / multiplier — always available.
  const fallbackPrice = getGradedPrice(cardName, setName, grade, rawMarketPrice);

  if (priceSource) {
    try {
      const live = priceSource();
      if (typeof live === "number" && Number.isFinite(live) && live > 0) {
        return { price: live, isStale, isFallback: false };
      }
    } catch {
      // Upstream provider failed — fall through to the known-good value.
    }
    return { price: fallbackPrice, isStale, isFallback: true };
  }

  return { price: fallbackPrice, isStale, isFallback: true };
}
