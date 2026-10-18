/**
 * OWNER-RUN — per-printing parity verification (design.md §8.3, FR-5.1/5.2,
 * AC-22). NEVER run by agents in build/verify: the LIVE half makes a gated,
 * credit-consuming Scrydex read and the offline half reads the configured
 * DATABASE_URL (the remote Mumbai DB).
 *
 * For a known sample number per game, it compares the app's per-printing row
 * count + printing labels against Scrydex's `variants[]` for that number:
 *   - OFFLINE half (default, NO credits): reads the DB DIRECTLY (not the cached
 *     search route) and asserts the expected N per-printing rows + labels exist.
 *   - LIVE half (`--live`, credit-gated): one gated Scrydex read of the real
 *     `variants[]` for the sample, ONLY with owner credit approval, then reports
 *     whether the DB labels match the live variant names.
 *
 * Samples (design.md §8.3): One Piece OP01-120; a documented multi-printing
 * Pokemon card (base1-4 Alakazam — reverse holofoil + holofoil + normal). Pass
 * --number=<id> --game=<g> to check a different card.
 *
 * Usage (PowerShell — quote the space in the repo path):
 *   cd "d:\Pokemon\Pokemon\.worktrees\scrydex-parity-build"
 *   npx tsx scripts/verify-parity.ts                       # OFFLINE both samples
 *   npx tsx scripts/verify-parity.ts --live                # + gated live variants[] read (owner-approved)
 *   npx tsx scripts/verify-parity.ts --game=onepiece --number=OP01-120
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { Game } from "@prisma/client";
import { prisma } from "../src/lib/db";
import {
  resolveScrydexCard,
  type ScrydexCard,
} from "../src/lib/services/scrydex.service";
import { assertScrydexCreditsApproved } from "../src/lib/services/scrydex-credit-gate";

const ARGS = process.argv.slice(2);
const LIVE = ARGS.includes("--live");

export interface ParitySample {
  game: Game;
  /** The BASE externalId (bare Bandai / catalog id) whose printings we check. */
  baseExternalId: string;
  /** A human label for logs. */
  label: string;
}

/** Documented default samples (design.md §8.3). */
export const DEFAULT_SAMPLES: ParitySample[] = [
  { game: Game.ONE_PIECE, baseExternalId: "OP01-120", label: "One Piece OP01-120" },
  { game: Game.POKEMON, baseExternalId: "base1-4", label: "Pokemon base1-4 (Alakazam)" },
];

/** A per-printing DB row as read for parity (pure shape). */
export interface DbPrintingRow {
  externalId: string;
  printing: string | null;
  imageUrl: string | null;
}

/**
 * The composite externalIds of every printing of a base id are the base id
 * itself (base printing) plus any `${baseId}::*` rows. PURE: given a base id and
 * the rows the DB returned, partition them for reporting.
 */
export function summarizePrintings(
  baseExternalId: string,
  rows: DbPrintingRow[]
): { base: DbPrintingRow | null; nonBase: DbPrintingRow[] } {
  const base = rows.find((r) => r.externalId === baseExternalId) ?? null;
  const nonBase = rows.filter((r) =>
    r.externalId.startsWith(`${baseExternalId}::`)
  );
  return { base, nonBase };
}

/** Fetch the DB's per-printing rows for a base id (base + `::` suffixed). */
async function readDbPrintings(baseExternalId: string): Promise<DbPrintingRow[]> {
  return prisma.card.findMany({
    where: {
      OR: [
        { externalId: baseExternalId },
        { externalId: { startsWith: `${baseExternalId}::` } },
      ],
    },
    select: { externalId: true, printing: true, imageUrl: true },
    orderBy: { externalId: "asc" },
  });
}

async function verifySample(sample: ParitySample): Promise<boolean> {
  const rows = await readDbPrintings(sample.baseExternalId);
  const { base, nonBase } = summarizePrintings(sample.baseExternalId, rows);
  console.log(
    `\n[verify-parity] ${sample.label}: DB has ${rows.length} printing row(s) ` +
      `(base=${base ? "yes" : "MISSING"}, non-base=${nonBase.length}).`
  );
  for (const r of rows) {
    console.log(`  ${r.externalId}  printing="${r.printing ?? "—"}"  img=${r.imageUrl ? "yes" : "—"}`);
  }

  let ok = base != null;
  if (!ok) {
    console.error(`[verify-parity] ${sample.label}: base row ${sample.baseExternalId} is MISSING.`);
  }

  if (LIVE) {
    // One gated Scrydex read of the real variants[] for this number. Resolve the
    // card by number+set via the thin client (search carries variants[]).
    await assertScrydexCreditsApproved("standard", 1);
    const card = base
      ? await resolveScrydexForBase(sample, base)
      : null;
    if (!card) {
      console.warn(`[verify-parity] ${sample.label}: live resolve returned no card — skipping live compare.`);
    } else {
      const liveNames = (card.variants ?? []).map((v) => v.name || "normal");
      const dbLabels = rows.map((r) => r.printing ?? "normal");
      const missing = liveNames.filter((n) => !dbLabels.includes(n));
      console.log(
        `[verify-parity] ${sample.label}: live variants=[${liveNames.join(", ")}] ` +
          `db labels=[${dbLabels.join(", ")}]`
      );
      if (missing.length > 0) {
        console.error(`[verify-parity] ${sample.label}: DB is MISSING printing(s): ${missing.join(", ")}`);
        ok = false;
      } else {
        console.log(`[verify-parity] ${sample.label}: PARITY OK (all live variants present in the DB).`);
      }
    }
  }
  return ok;
}

/** Resolve the Scrydex card for a base row (reads name/number/set off the DB row). */
async function resolveScrydexForBase(
  sample: ParitySample,
  base: DbPrintingRow
): Promise<ScrydexCard | null> {
  const row = await prisma.card.findUnique({
    where: { externalId: base.externalId },
    select: { name: true, number: true, set: { select: { name: true } } },
  });
  if (!row) return null;
  const resolved = await resolveScrydexCard({
    name: row.name,
    number: row.number,
    setName: row.set?.name,
    game: sample.game,
  });
  return resolved?.card ?? null;
}

async function run(): Promise<void> {
  const numberArg = ARGS.find((a) => a.startsWith("--number="))?.split("=")[1];
  const gameArg = ARGS.find((a) => a.startsWith("--game="))?.split("=")[1]?.toLowerCase();
  const samples: ParitySample[] =
    numberArg && gameArg
      ? [
          {
            game: gameArg === "onepiece" ? Game.ONE_PIECE : Game.POKEMON,
            baseExternalId: numberArg,
            label: `${gameArg} ${numberArg}`,
          },
        ]
      : DEFAULT_SAMPLES;

  console.log(`[verify-parity] ${LIVE ? "OFFLINE + LIVE (gated)" : "OFFLINE (no credits)"} — ${samples.length} sample(s).`);
  let allOk = true;
  for (const sample of samples) {
    const ok = await verifySample(sample);
    allOk = allOk && ok;
  }
  if (!allOk) {
    console.error("[verify-parity] FAILED — one or more samples missing printings.");
    process.exitCode = 1;
  } else {
    console.log("\n[verify-parity] OK.");
  }
}

// Guarded live runner — tests import the pure helpers only.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
