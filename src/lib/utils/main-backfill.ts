/**
 * main-backfill — PURE planner for the owner-run null → Main backfill
 * (scripts/backfill-main-collection.ts). No I/O: the script feeds it rows and
 * applies the result.
 *
 * A move can collide with the DB partial unique index `uc_variant_coalesced`
 * (userId, COALESCE(collectionId,''), cardId, isFoil, COALESCE(condition,''))
 * WHERE isSold=false. Such rows are reported as `conflicts` and NOT moved.
 * Sold rows are never moved (history stays as-is) and are reported.
 */
export interface LotKey {
  userId: string;
  cardId: string;
  isFoil: boolean;
  condition: string | null;
  isSold: boolean;
}
export type BackfillRow = LotKey & { id: string };

export interface BackfillPlan {
  movable: BackfillRow[];
  conflicts: BackfillRow[];
  skippedSold: BackfillRow[];
  perUser: Record<string, { movable: number; conflicts: number; skippedSold: number }>;
}

// Normalized like the add route (trim + upper) — slightly stricter than the
// index, so borderline rows are reported rather than risking a P2002 mid-apply.
const variantKey = (r: LotKey) =>
  [r.userId, r.cardId, r.isFoil ? 1 : 0, (r.condition ?? "").trim().toUpperCase()].join("|");

export function planMainBackfill(unassigned: BackfillRow[], existingMain: BackfillRow[]): BackfillPlan {
  const mainKeys = new Set(existingMain.filter((r) => !r.isSold).map(variantKey));
  const plan: BackfillPlan = { movable: [], conflicts: [], skippedSold: [], perUser: {} };
  for (const r of unassigned) {
    const u = (plan.perUser[r.userId] ??= { movable: 0, conflicts: 0, skippedSold: 0 });
    if (r.isSold) {
      plan.skippedSold.push(r);
      u.skippedSold++;
    } else if (mainKeys.has(variantKey(r))) {
      plan.conflicts.push(r);
      u.conflicts++;
    } else {
      plan.movable.push(r);
      u.movable++;
    }
  }
  return plan;
}

/** Rollback = manifest entries whose row is CURRENTLY in that same user's Main. */
export function planRollback(
  manifest: { id: string; userId: string }[],
  currentMain: { id: string; userId: string }[]
) {
  const inMain = new Set(currentMain.map((r) => `${r.userId}|${r.id}`));
  return manifest.filter((m) => inMain.has(`${m.userId}|${m.id}`));
}
