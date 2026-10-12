/**
 * OWNER-RUN - writes to the configured DATABASE_URL + makes LIVE, credit-
 * consuming Scrydex catalog calls; NEVER run by agents and NEVER in build/verify.
 *
 * Backfills One Piece `Card.variantImages` by re-fetching each card's per-variant
 * images from the Scrydex catalog (alt-art fix). The ingest writer only populates
 * variantImages on a priced pull; this script fills the existing catalog in one
 * owner-approved pass.
 *
 * SCOPE: One Piece ONLY — rows whose `set.externalId` starts with "onepiece-".
 * Pokémon rows are NEVER selected, and every write re-checks the set scope.
 *
 * CREDIT GATING (load-bearing): the Scrydex catalog resolve/by-id call costs ~1
 * credit per card. BEFORE any live call this script calls
 * `assertScrydexCreditsApproved("standard", cardCount)` from
 * `@/lib/services/scrydex-credit-gate` (DENY by default — approve via
 * SCRYDEX_LIVE_CREDITS_APPROVED=true or the admin Redis flag). DRY RUN (default)
 * makes NO network calls and NO writes — it only counts from the DB and prints a
 * credit estimate.
 *
 * IDEMPOTENT: the new map is compared to the stored map via a canonical,
 * key-sorted stringify, treating {} ≡ null as equal, so a no-change card is a
 * no-op. This backfill is the SOLE null-clearer — it MAY write null to clear a
 * stale/empty map (the price writer never writes null).
 *
 * Usage (PowerShell — the repo path contains a space, always quote it):
 *   cd "d:\Pokemon\Pokemon\.worktrees\op-altart"
 *   npx tsx scripts/backfill-onepiece-variant-images.ts            # DRY RUN: count + credit estimate, no network, no writes
 *   # After owner approval + SCRYDEX_LIVE_CREDITS_APPROVED=true:
 *   npx tsx scripts/backfill-onepiece-variant-images.ts --apply    # live fetch + write
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { Game } from "@prisma/client";
import {
  resolveScrydexCard,
  fetchScrydexCardById,
  pickVariantImages,
} from "../src/lib/services/scrydex.service";
import {
  assertScrydexCreditsApproved,
  estimateCredits,
} from "../src/lib/services/scrydex-credit-gate";

const APPLY = process.argv.slice(2).includes("--apply");
const ONEPIECE_SCOPE = { set: { externalId: { startsWith: "onepiece-" } } } as const;

/** Scrydex One Piece set code from the Bandai externalId prefix (OP08-023 → OP08). */
function deriveOnePieceSetCode(externalId: string): string | undefined {
  const prefix = externalId.split("-")[0];
  return /^(OP|ST|EB|PRB)\d{2}$/i.test(prefix) ? prefix.toUpperCase() : undefined;
}

/** Canonical, key-sorted JSON of a variant-images map; {} and null both → "". */
function canonical(map: unknown): string {
  if (map == null || typeof map !== "object") return "";
  const obj = map as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (keys.length === 0) return "";
  const norm: Record<string, unknown> = {};
  for (const k of keys) {
    const v = obj[k];
    if (v && typeof v === "object") {
      const inner = v as Record<string, unknown>;
      const ik = Object.keys(inner).sort();
      const io: Record<string, unknown> = {};
      for (const key of ik) io[key] = inner[key];
      norm[k] = io;
    } else {
      norm[k] = v;
    }
  }
  return JSON.stringify(norm);
}

async function backfill(): Promise<void> {
  const cards = await prisma.card.findMany({
    where: ONEPIECE_SCOPE,
    select: {
      id: true,
      externalId: true,
      name: true,
      number: true,
      game: true,
      scrydexId: true,
      variantImages: true,
      set: { select: { name: true } },
    },
  });

  console.log(`[backfill-op-variant-images] ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(
    `[backfill-op-variant-images] One Piece cards=${cards.length} ` +
      `creditEstimate≈${estimateCredits("standard", cards.length)} (~1 credit/card)`
  );

  if (!APPLY) {
    // DRY RUN: NO network, NO writes, NO credit spend. Count only + sample.
    for (const c of cards.slice(0, 5)) {
      console.log(
        `[sample] ${c.externalId} storedVariantImages=${canonical(c.variantImages) || "(none)"}`
      );
    }
    console.log("[backfill-op-variant-images] dry run only. Re-run with --apply (owner-approved) to fetch + write.");
    return;
  }

  // Live path: hard credit gate FIRST — throws ScrydexCreditsNotApproved if denied.
  await assertScrydexCreditsApproved("standard", cards.length);

  let updated = 0;
  let cleared = 0;
  let unchanged = 0;
  let unresolved = 0;

  for (const c of cards) {
    try {
      const scrydexCard = c.scrydexId
        ? await fetchScrydexCardById(c.scrydexId, Game.ONE_PIECE)
        : (
            await resolveScrydexCard({
              name: c.name,
              number: c.number,
              setName: c.set?.name ?? undefined,
              setCode: deriveOnePieceSetCode(c.externalId),
              game: Game.ONE_PIECE,
            })
          )?.card ?? null;

      if (!scrydexCard) {
        unresolved++;
        continue;
      }

      const next = pickVariantImages(scrydexCard);
      if (canonical(next) === canonical(c.variantImages)) {
        unchanged++; // idempotent: {} ≡ null ≡ identical map → no-op
        continue;
      }

      // Non-empty → write the map; empty → clear to null (sole null-clearer).
      const data = Object.keys(next).length > 0 ? { variantImages: next } : { variantImages: null };
      // Keyed by id AND re-scoped to One Piece so a Pokémon row can never be written.
      const res = await prisma.card.updateMany({
        where: { id: c.id, ...ONEPIECE_SCOPE },
        data,
      });
      if (res.count > 0) {
        if (Object.keys(next).length > 0) updated++;
        else cleared++;
      }
    } catch (err) {
      console.warn(`[backfill-op-variant-images] ${c.externalId} failed:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(
    `[backfill-op-variant-images] updated=${updated} cleared=${cleared} ` +
      `unchanged=${unchanged} unresolved=${unresolved}`
  );
}

backfill()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
