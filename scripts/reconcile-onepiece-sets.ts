/**
 * OWNER-RUN — one-off cleanup of the duplicated One Piece CardSet rows.
 *
 * DANGER: writes to the configured DATABASE_URL and DELETES CardSet rows.
 * `CardSet → Card` is `onDelete: Cascade`, so deleting a NON-empty set would
 * destroy its cards (and cascade to owned UserCollection / price / history
 * rows). This script therefore NEVER deletes a set that still has cards: it
 * re-points every card off the loser rows onto the canonical keeper FIRST, then
 * re-queries each loser's live count and refuses to delete any row that is not
 * 0-card. The whole move+delete runs in ONE transaction with a before/after
 * total-card-count invariant — a mismatch aborts (rolls back) the transaction.
 *
 * WHAT IT DOES (One Piece ONLY — `CardSet.externalId LIKE 'onepiece-%'`):
 *   - Groups CardSet rows by normalized set NAME (lower(trim(name))).
 *   - For each name group with >1 row, picks the canonical keeper via the pure
 *     `pickOnePieceSetKeeper` (plain slug > third-variant > CODE row; highest
 *     card count within a tier). A name group with a single row (incl. a lone
 *     CODE row, or a genuine promo set) is left untouched.
 *   - Re-points `Card.setId` from each loser to the keeper, then deletes the
 *     now-empty loser CardSet rows.
 *
 * IDEMPOTENT: after a successful apply every name group is a single row, so a
 * second run finds no >1 groups → 0 moves, 0 deletes.
 *
 * CREDS: reads DATABASE_URL / DIRECT_URL from env ONLY (never hardcoded). Run
 * from the Droplet one-off container per .agents/tasks/onepiece-reconcile/runbook.md.
 *
 * Usage (PowerShell — the repo path contains a space, always quote it):
 *   npx tsx scripts/reconcile-onepiece-sets.ts            # DRY RUN (default): prints the plan, NO writes
 *   npx tsx scripts/reconcile-onepiece-sets.ts --apply    # EXECUTE: move cards + delete empty phantoms (one transaction)
 */
import { pathToFileURL } from "node:url";
import { prisma } from "../src/lib/db";
import {
  pickOnePieceSetKeeper,
  type KeeperPlan,
  type OnePieceSetRow,
} from "../src/lib/utils/onepiece-set-key";

const APPLY = process.argv.slice(2).includes("--apply");
const LOG = "[reconcile-op]";

/** Internal CardSet.id alongside the human-facing externalId (RULE 3). */
interface SetRecord extends OnePieceSetRow {
  id: string;
}

/** Group raw rows by normalized set NAME (lower(trim(name))). */
function groupByName(rows: SetRecord[]): Map<string, SetRecord[]> {
  const groups = new Map<string, SetRecord[]>();
  for (const r of rows) {
    const key = r.name.trim().toLowerCase();
    const bucket = groups.get(key);
    if (bucket) bucket.push(r);
    else groups.set(key, [r]);
  }
  return groups;
}

/** A keeper plan that still carries internal ids, for the write phase. */
interface SetKeeperPlan {
  name: string;
  keeper: SetRecord;
  losers: SetRecord[];
}

/**
 * Build the per-group keeper plans from the loaded rows. Pure w.r.t. the DB —
 * delegates the canonical choice to `pickOnePieceSetKeeper` and re-attaches the
 * internal id by externalId. Only groups with at least one loser are returned.
 */
function buildPlans(rows: SetRecord[]): SetKeeperPlan[] {
  const byId = new Map(rows.map((r) => [r.externalId, r]));
  const plans: SetKeeperPlan[] = [];
  for (const [name, group] of groupByName(rows)) {
    if (group.length < 2) continue; // single-row group → leave untouched
    const picked: KeeperPlan = pickOnePieceSetKeeper(group);
    const keeper = byId.get(picked.keeper.externalId);
    if (!keeper) continue; // unreachable — keeper came from the group
    const losers = picked.losers
      .map((l) => byId.get(l.externalId))
      .filter((r): r is SetRecord => r != null);
    plans.push({ name, keeper, losers });
  }
  return plans;
}

/** Load every `onepiece-%` CardSet with its live card count (ONE query). */
async function loadOnePieceSets(): Promise<SetRecord[]> {
  const sets = await prisma.cardSet.findMany({
    where: { externalId: { startsWith: "onepiece-" } },
    select: { id: true, externalId: true, name: true, _count: { select: { cards: true } } },
  });
  return sets.map((s) => ({
    id: s.id,
    externalId: s.externalId,
    name: s.name,
    cardCount: s._count.cards,
  }));
}

async function run(): Promise<void> {
  const rows = await loadOnePieceSets();
  const plans = buildPlans(rows);

  const cardsToMove = plans.reduce(
    (sum, p) => sum + p.losers.reduce((s, l) => s + l.cardCount, 0),
    0
  );
  const setsToDelete = plans.reduce((sum, p) => sum + p.losers.length, 0);

  if (!APPLY) {
    console.log(`${LOG} DRY RUN (no --apply) — NO writes.`);
    console.log(`${LOG} ${rows.length} One Piece set row(s); ${plans.length} name group(s) with duplicates.`);
    for (const p of plans) {
      console.log(`\n${LOG} name "${p.name}"`);
      console.log(`  KEEP   ${p.keeper.externalId} (${p.keeper.cardCount} card(s))`);
      for (const l of p.losers) {
        console.log(
          `  loser  ${l.externalId} (${l.cardCount} card(s)) — would move ${l.cardCount} card(s), then delete the row`
        );
      }
    }
    console.log(`\n${LOG} SUMMARY: ${cardsToMove} card(s) to move, ${setsToDelete} set(s) to delete.`);
    console.log(`${LOG} Re-run with --apply to execute.\n`);
    return;
  }

  if (plans.length === 0) {
    console.log(`${LOG} APPLY — nothing to reconcile (every name group is already a single row).`);
    return;
  }

  // Count all One Piece cards BEFORE (scoped to the onepiece-% sets the script
  // can touch) so we can assert the total is unchanged after move+delete.
  const totalBefore = await prisma.card.count({
    where: { set: { externalId: { startsWith: "onepiece-" } } },
  });

  const result = await prisma.$transaction(async (tx) => {
    let moved = 0;
    let deleted = 0;

    for (const plan of plans) {
      // 1) Re-point every loser's cards onto the keeper. Card.externalId is
      //    globally unique, so no card collides on the new setId.
      for (const loser of plan.losers) {
        if (loser.cardCount > 0) {
          const { count } = await tx.card.updateMany({
            where: { setId: loser.id },
            data: { setId: plan.keeper.id },
          });
          moved += count;
        }
      }
      // 2) Delete each loser — but re-query its LIVE count first and refuse to
      //    delete any row that still has cards (never cascade-destroy cards).
      for (const loser of plan.losers) {
        const fresh = await tx.card.count({ where: { setId: loser.id } });
        if (fresh !== 0) {
          throw new Error(
            `${LOG} ABORT: loser ${loser.externalId} still has ${fresh} card(s) — refusing to delete (would cascade). Rolling back.`
          );
        }
        await tx.cardSet.delete({ where: { id: loser.id } });
        deleted++;
      }
    }

    // 3) Invariant — total One Piece card count must be UNCHANGED. A mismatch
    //    means a card was lost (e.g. an unexpected cascade); abort → rollback.
    const totalAfter = await tx.card.count({
      where: { set: { externalId: { startsWith: "onepiece-" } } },
    });
    if (totalAfter !== totalBefore) {
      throw new Error(
        `${LOG} ABORT: One Piece card count changed (${totalBefore} → ${totalAfter}). Rolling back.`
      );
    }

    return { moved, deleted, totalBefore, totalAfter };
  });

  console.log(`${LOG} APPLY done.`);
  console.log(`  cards moved     : ${result.moved}`);
  console.log(`  sets deleted    : ${result.deleted}`);
  console.log(`  One Piece cards : ${result.totalBefore} → ${result.totalAfter} (unchanged — invariant held)`);
}

// Run only when invoked directly (not on import), so a test can import the
// module without opening a DB connection. Mirrors ingest-onepiece-catalog.ts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
