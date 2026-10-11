/**
 * OWNER-RUN - writes to the configured DATABASE_URL; never run by agents.
 *
 * Backfills existing One Piece `Card.number` to the FULL Bandai code so it
 * equals what the scanner's recognizer parses off the card. One Piece
 * externalId IS the full code (card.service.ts sets `id = p.code`), so the
 * fix is simply `number = externalId` for One Piece rows.
 *
 * SCOPE: One Piece ONLY — rows whose `set.externalId` starts with
 * "onepiece-". Pokémon rows are NEVER in scope (the write re-checks the
 * set-scope guard, so a Pokémon row can never be touched).
 *
 * Idempotent: only rows where `number !== externalId` are selected, so a
 * second run is a no-op. NO live Scrydex calls, NO credit spend, NO network —
 * it copies a value that is already in the DB.
 *
 * Usage (PowerShell — the repo path contains a space, always quote it):
 *   cd "d:\Pokemon\Pokemon\.worktrees\scan-opnumber"
 *   npx tsx scripts/backfill-onepiece-number.ts            # DRY RUN (default): counts + sample, no writes
 *   npx tsx scripts/backfill-onepiece-number.ts --apply    # set number = externalId for One Piece rows
 *
 * Rollback: re-deriving the bare tail is the rollback — the previous value was
 * `externalId.split("-").pop()` (e.g. "OP01-064" -> "064"). No manifest needed
 * because the source value (externalId) is never mutated and is lossless.
 */
import { prisma } from "../src/lib/db";

const APPLY = process.argv.slice(2).includes("--apply");

const ONEPIECE_SCOPE = { set: { externalId: { startsWith: "onepiece-" } } } as const;

async function backfill(): Promise<void> {
  const total = await prisma.card.count({ where: ONEPIECE_SCOPE });

  // Rows needing a fix: One Piece cards whose stored number is not already the
  // full externalId. Prisma has no column-to-column comparison, so pull the
  // small projection and filter in memory (One Piece catalog is modest).
  const rows = await prisma.card.findMany({
    where: ONEPIECE_SCOPE,
    select: { id: true, externalId: true, number: true },
  });
  const needing = rows.filter((r) => r.number !== r.externalId);

  console.log(`[backfill-op-number] ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`[backfill-op-number] One Piece cards total=${total} needingFix=${needing.length}`);
  for (const r of needing.slice(0, 5)) {
    console.log(`[sample] ${r.id}  number "${r.number}" -> "${r.externalId}"`);
  }

  if (!APPLY) {
    console.log("[backfill-op-number] dry run only. Re-run with --apply to write.");
    return;
  }

  let updated = 0;
  for (const r of needing) {
    // Keyed by id AND re-scoped to One Piece sets so a Pokémon row can never be
    // written even if the id list were stale.
    const res = await prisma.card.updateMany({
      where: { id: r.id, ...ONEPIECE_SCOPE },
      data: { number: r.externalId },
    });
    updated += res.count;
  }
  console.log(`[backfill-op-number] updated ${updated} One Piece rows (number = full Bandai code)`);
}

backfill()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
