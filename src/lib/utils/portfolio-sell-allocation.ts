/**
 * BUG 3 (audit 13 F-02) — portfolio sell allocation across a consolidated tile's
 * merged UserCollection rows.
 *
 * A tile may merge several active lots (same card/set/foil/condition/collection).
 * Selling up to the tile's SUMMED quantity must draw across those underlying
 * rows, not only the first one (which threw "Cannot sell N; only M owned").
 *
 * Pure + deterministic (RULE 11). Oldest `addedAt` first (RULE 9) so the draws
 * match the collection's add ordering; ties break by stable id order.
 */

export interface SellRow {
  id: string;
  quantity: number;
  /** ISO timestamp; oldest is drained first. */
  addedAt: string;
}

export interface SellDraw {
  id: string;
  quantity: number;
}

/**
 * Allocate `qty` copies to sell across `rows`, oldest `addedAt` first.
 * Returns the per-row draws (only rows that contribute). Throws when `qty` is
 * not a positive integer or exceeds the summed available quantity.
 */
export function allocateSell(rows: SellRow[], qty: number): SellDraw[] {
  if (!Number.isInteger(qty) || qty < 1) {
    throw new Error("Sell quantity must be a positive integer.");
  }
  const available = rows.reduce((a, r) => a + r.quantity, 0);
  if (qty > available) {
    throw new Error(`Cannot sell ${qty}; only ${available} owned.`);
  }

  // Oldest first (ascending addedAt), stable tie-break on id.
  const ordered = [...rows].sort((a, b) => {
    const ta = Date.parse(a.addedAt);
    const tb = Date.parse(b.addedAt);
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const draws: SellDraw[] = [];
  let remaining = qty;
  for (const row of ordered) {
    if (remaining <= 0) break;
    const take = Math.min(row.quantity, remaining);
    if (take > 0) {
      draws.push({ id: row.id, quantity: take });
      remaining -= take;
    }
  }
  return draws;
}
