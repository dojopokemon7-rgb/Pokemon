/**
 * Multi-collection comparison series (pure — no I/O). Plan §6:
 *   - ONE series per collection; NEVER summed into a single total.
 *   - Time on X, collection value on Y, with shaded areas per series.
 *   - A card contributes to a collection's value ONLY within its ownership
 *     interval [addedAt, soldAt). We never value a card in a collection before
 *     it was actually added, and we stop valuing it once sold.
 *   - Value at time t uses the NEAREST real stored price point at or before t
 *     for the card (carry-forward of real data). If no real price exists at/
 *     before t, that card contributes nothing yet — an HONEST gap, never a
 *     fabricated or interpolated value.
 *   - BUG 1 & 8: a lot is valued from the price series MATCHING ITS OWN GRADE.
 *     Raw, PSA 9, PSA 10, CGC 10 rows share one cardId (often one recordedAt),
 *     so carrying forward whichever row sorts last mis-values the lot. Each lot
 *     carries its `condition`; a GRADED lot (parseGradedCondition matches a
 *     company+grade) is valued ONLY from that company+grade's graded points, a
 *     RAW lot ONLY from the best-available raw condition's points — the SAME
 *     selection statsFromLots/displayPrice use. No fabrication: a lot whose
 *     matching series is empty stays an honest null gap.
 */

import {
  parseGradedCondition,
  isRawRow,
  pickBestRaw,
  pickDefaultVariant,
  type PriceRowLike,
} from "@/lib/utils/raw-price";

export interface HoldingInterval {
  collectionId: string; // which collection this lot belongs to (the ALL view can pre-group)
  cardId: string;
  quantity: number;
  addedAt: number; // epoch ms — ownership start (inclusive)
  soldAt: number | null; // epoch ms — ownership end (exclusive); null = still held
  // BUG 1 & 8: the lot's stored graded condition ("PSA 10", "CGC 9.5") or raw
  // ("NM"/null). Drives which per-grade price series values this lot. Omitted
  // (undefined) behaves exactly like a RAW lot — so legacy fixtures that never
  // set it keep their current raw valuation.
  condition?: string | null;
}

export interface PricePoint {
  cardId: string;
  at: number; // epoch ms
  price: number; // real stored market price (source-native; charts stay source-native)
  // BUG 1 & 8: the price row's own identity, so a lot can filter to the series
  // matching its grade. All optional — a point with no `type` is treated as raw
  // (the established isRawRow semantics), so fixtures that omit these are raw.
  type?: string | null;
  company?: string | null;
  grade?: string | null;
  variant?: string | null;
  condition?: string | null; // raw condition (NM/LP/…) for pickBestRaw ranking
}

export interface SeriesPoint {
  t: number; // epoch ms
  value: number | null; // null = honest gap (no real data to value the collection yet)
}

export interface CollectionSeries {
  collectionId: string;
  points: SeriesPoint[];
}

/** Nearest real price at or before `t` for a card, or null (carry-forward). */
function priceAtOrBefore(sorted: PricePoint[], t: number): number | null {
  // sorted ascending by `at`. Linear scan is fine for per-card point counts;
  // callers pass already-filtered per-card arrays.
  let found: number | null = null;
  for (const p of sorted) {
    if (p.at <= t) found = p.price;
    else break;
  }
  return found;
}

/**
 * Build one value series per collection over the given timeline.
 *
 * @param holdings  ownership intervals (one per lot), already grouped by the
 *                  collectionId the caller wants (for the ALL view, pass a
 *                  single synthetic collectionId across every owned lot).
 * @param prices    real stored price points (any order).
 * @param timeline  epoch-ms timestamps to evaluate, ascending.
 */
export function buildCollectionSeries(
  holdings: HoldingInterval[],
  prices: PricePoint[],
  timeline: number[]
): CollectionSeries[] {
  // Index prices per card (unsorted — the per-lot grade filter below sorts its
  // own filtered slice ascending for carry-forward).
  const byCard = new Map<string, PricePoint[]>();
  for (const p of prices) {
    const arr = byCard.get(p.cardId) ?? [];
    arr.push(p);
    byCard.set(p.cardId, arr);
  }

  // BUG 1 & 8: build the ascending carry-forward series for ONE lot, filtered
  // to the price points matching its grade. A GRADED lot keeps only that
  // company+grade's graded points; a RAW lot keeps only raw points at the best
  // available condition (NM→LP→MP→HP→DM, the pickBestRaw ranking). The filtered
  // points are converted to PriceRowLike for the shared raw/graded helpers so
  // selection is byte-identical to statsFromLots/displayPrice. No fabrication:
  // an empty filtered series stays an honest null gap. Memoized per
  // (cardId, condition) so N lots of the same card+grade only filter once.
  const lotSeriesCache = new Map<string, PricePoint[]>();
  function lotSeries(cardId: string, condition: string | null | undefined): PricePoint[] {
    const key = `${cardId}\u0000${condition ?? ""}`;
    const cached = lotSeriesCache.get(key);
    if (cached) return cached;

    const all = byCard.get(cardId) ?? [];
    const graded = parseGradedCondition(condition);
    let filtered: PricePoint[];
    if (graded) {
      // Graded lot: only this company+grade's graded points.
      const company = graded.company.toUpperCase();
      filtered = all.filter(
        (p) =>
          (p.type ?? "") === "graded" &&
          (p.company ?? "").toUpperCase() === company &&
          (p.grade ?? "") === graded.grade
      );
    } else {
      // Raw lot: raw points only, at the best available raw condition. The
      // shared helpers (pickBestRaw/pickDefaultVariant) read priceMarket, so
      // adapt each point to a PriceRowLike carrying its grade identity + price.
      const rawRows: PriceRowLike[] = all
        .filter((p) => isRawRow(p))
        .map((p) => ({
          type: p.type,
          company: p.company,
          grade: p.grade,
          variant: p.variant,
          condition: p.condition,
          priceMarket: p.price,
        }));
      const best = pickBestRaw(rawRows);
      // Keep only the raw points matching the winning (condition, variant) so
      // carry-forward is grade-pure; fall back to the default variant's raw
      // points when no RAW_CONDITION_ORDER label matched.
      const variant = best ? best.variant : pickDefaultVariant(rawRows);
      filtered = all.filter((p) => {
        if (!isRawRow(p)) return false;
        if (best && (p.condition ?? "") !== best.condition) return false;
        if (variant != null && (p.variant ?? "normal") !== variant) return false;
        return true;
      });
    }
    filtered = [...filtered].sort((a, b) => a.at - b.at);
    lotSeriesCache.set(key, filtered);
    return filtered;
  }

  // Group holdings by collection.
  const byCollection = new Map<string, HoldingInterval[]>();
  for (const h of holdings) {
    const arr = byCollection.get(h.collectionId) ?? [];
    arr.push(h);
    byCollection.set(h.collectionId, arr);
  }

  const series: CollectionSeries[] = [];
  for (const [collectionId, lots] of byCollection) {
    const points: SeriesPoint[] = timeline.map((t) => {
      let total = 0;
      let anyContribution = false;
      for (const lot of lots) {
        // Ownership interval: contributes only within [addedAt, soldAt).
        if (t < lot.addedAt) continue;
        if (lot.soldAt != null && t >= lot.soldAt) continue;
        // Value this lot from the price series matching ITS OWN grade.
        const price = priceAtOrBefore(lotSeries(lot.cardId, lot.condition), t);
        if (price == null) continue; // honest gap — no real data to value this lot yet
        total += price * lot.quantity;
        anyContribution = true;
      }
      // If nothing in this collection could be valued at t (nothing owned yet,
      // or no real price exists), emit a null gap rather than a fabricated 0.
      return { t, value: anyContribution ? total : null };
    });
    series.push({ collectionId, points });
  }
  return series;
}
