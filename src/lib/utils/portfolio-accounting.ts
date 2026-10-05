/**
 * Portfolio accounting (pure — no I/O). The money math behind Market Value,
 * Paid, Realized, and Unrealized P&L (plan §5).
 *
 * HONESTY RULES (plan §5, "never invent"):
 *   - Cost basis is UNRESOLVED when no usable price could be captured. An
 *     unresolved basis is `null`, never 0, and any P&L that depends on it is
 *     reported as `{ status: "unresolved" }`, never a fabricated number.
 *   - Realized P&L = gross proceeds − allocated cost basis. Fees/shipping are
 *     explicitly EXCLUDED.
 *   - Partial sales allocate cost basis PROPORTIONALLY, so the sum of
 *     allocations across all partial sales of a lot equals the lot's total
 *     basis (no basis is created or lost by splitting).
 */

export type PnL =
  | { status: "resolved"; value: number }
  | { status: "unresolved" };

/**
 * Allocate cost basis to a sold quantity proportionally from a per-copy basis.
 * `basisPerCopy` null → the whole allocation is unresolved.
 */
export function allocateBasis(
  basisPerCopy: number | null,
  soldQty: number
): number | null {
  if (basisPerCopy == null) return null;
  if (!Number.isFinite(basisPerCopy) || soldQty <= 0) return 0;
  return basisPerCopy * soldQty;
}

/**
 * Realized P&L for a sold lot: grossProceeds − allocatedBasis. `basisPerCopy`
 * null → unresolved (we sold it but never knew what it cost, so a numeric P&L
 * would be a lie). Fees/shipping are not part of this (plan §5).
 *
 * @param soldQty       number of copies sold
 * @param grossPerCopy  gross sale price per copy
 * @param basisPerCopy  cost basis per copy, or null when unresolved
 */
export function realizedPnL(
  soldQty: number,
  grossPerCopy: number,
  basisPerCopy: number | null
): PnL {
  if (basisPerCopy == null) return { status: "unresolved" };
  const proceeds = grossPerCopy * soldQty;
  const basis = allocateBasis(basisPerCopy, soldQty) ?? 0;
  return { status: "resolved", value: proceeds - basis };
}

/**
 * Unrealized P&L for an owned lot: (marketPerCopy − basisPerCopy) × qty.
 * Unresolved when either the market value or the cost basis is unknown — we
 * never substitute 0 for a missing number.
 */
export function unrealizedPnL(
  qty: number,
  marketPerCopy: number | null,
  basisPerCopy: number | null
): PnL {
  if (marketPerCopy == null || basisPerCopy == null) return { status: "unresolved" };
  return { status: "resolved", value: (marketPerCopy - basisPerCopy) * qty };
}

export interface PortfolioStats {
  /** Σ current market value over ACTIVE (unsold) holdings. */
  marketValue: number;
  /** Σ resolved cost basis over active holdings (unresolved excluded + counted). */
  paid: number;
  /** Σ realized P&L over sold lots with a resolved basis. */
  realized: number;
  /** marketValue − paid over holdings where BOTH are resolved. */
  unrealized: number;
  /** How many lots have an unresolved cost basis (surfaced in the UI). */
  unresolvedCount: number;
}

export interface ActiveLot {
  qty: number;
  marketPerCopy: number | null;
  basisPerCopy: number | null;
}

export interface SoldLot {
  qty: number;
  grossPerCopy: number;
  basisPerCopy: number | null;
}

/**
 * Aggregate portfolio stats from active + sold lots. Resolved and unresolved
 * contributions are kept separate: an unresolved lot adds to `unresolvedCount`
 * and is EXCLUDED from the numeric sums (never silently treated as 0 value).
 */
export function aggregatePortfolio(
  active: ActiveLot[],
  sold: SoldLot[]
): PortfolioStats {
  let marketValue = 0;
  let paid = 0;
  let unrealized = 0;
  let realized = 0;
  let unresolvedCount = 0;

  for (const lot of active) {
    if (lot.marketPerCopy != null) marketValue += lot.marketPerCopy * lot.qty;
    if (lot.basisPerCopy != null) {
      paid += lot.basisPerCopy * lot.qty;
    } else {
      unresolvedCount += 1;
    }
    const u = unrealizedPnL(lot.qty, lot.marketPerCopy, lot.basisPerCopy);
    if (u.status === "resolved") unrealized += u.value;
  }

  for (const lot of sold) {
    const r = realizedPnL(lot.qty, lot.grossPerCopy, lot.basisPerCopy);
    if (r.status === "resolved") realized += r.value;
    else unresolvedCount += 1;
  }

  return { marketValue, paid, realized, unrealized, unresolvedCount };
}

/**
 * A raw collection lot as stored / returned by GET /collection — the SINGLE
 * shape both the dashboard and portfolio views aggregate from. Mapping it to
 * {@link aggregatePortfolio} here (one place) is what keeps the two views from
 * ever disagreeing on the same card.
 *
 * IMPORTANT provenance (sell route): `soldPrice` is the GROSS TOTAL proceeds
 * for the row's `quantity` (grossPerCopy × quantity), while `purchasePrice` is
 * PER COPY. So a sold lot's grossPerCopy is `soldPrice / quantity` — multiplying
 * `soldPrice` by quantity again (the old inline dashboard math) double-counts.
 */
export interface RawLot {
  quantity: number;
  purchasePrice: number | null;
  marketPrice: number | null;
  isSold?: boolean | null;
  soldPrice?: number | null;
}

/**
 * Aggregate portfolio stats straight from raw collection rows — the shared
 * source of truth for BOTH the dashboard stat card and the portfolio summary.
 * Splits active vs sold, derives per-copy gross from the stored gross total,
 * and defers all honesty rules (null basis never 0, unresolved excluded +
 * counted) to {@link aggregatePortfolio}.
 */
export function statsFromLots(lots: readonly RawLot[]): PortfolioStats {
  const active: ActiveLot[] = [];
  const sold: SoldLot[] = [];
  for (const lot of lots) {
    if (lot.isSold) {
      // soldPrice is the gross TOTAL for lot.quantity → per-copy = total / qty.
      const grossPerCopy = lot.quantity > 0 ? (lot.soldPrice ?? 0) / lot.quantity : 0;
      sold.push({ qty: lot.quantity, grossPerCopy, basisPerCopy: lot.purchasePrice });
    } else {
      active.push({
        qty: lot.quantity,
        marketPerCopy: lot.marketPrice,
        basisPerCopy: lot.purchasePrice,
      });
    }
  }
  return aggregatePortfolio(active, sold);
}
