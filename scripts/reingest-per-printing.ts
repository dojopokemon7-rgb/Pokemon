/**
 * OWNER-RUN — the gated, dry-run-default re-ingest + per-printing migration
 * orchestrator (design.md §7, design-addendum HIGH-1 / MEDIUM-1 / MEDIUM-2).
 * NEVER run by agents and NEVER in build/verify: every live page fetch is
 * credit-gated (DENY by default) and every write lands in the configured
 * DATABASE_URL (the remote Mumbai DB).
 *
 * WHAT IT DOES
 *   One game per run (`--game=onepiece|pokemon`; One Piece first per the owner
 *   sequencing). It re-ingests the Scrydex catalog into the per-printing
 *   re-model (one Card row per `variants[]` entry) via the FEAT-002 PURE
 *   mappers, applying the addendum's two-pass per-set transactional mechanism:
 *
 *   Pass 1 (gated reads, NO writes) pages the catalog (pageSize=100, 1 credit
 *   per page), runs the pure mapper per card, resolves the Pokemon baseId per
 *   card by a READ-ONLY match-then-upsert (scrydexId else game+set-name+number,
 *   else green-field c.id), and buffers the mapped rows in memory keyed by the
 *   set grouping key (OP: onePieceSetExternalId(setName); PKM: pokemon-<exp.id>).
 *
 *   Pass 2 flushes each buffered SET inside ONE prisma.$transaction: read
 *   before-counts, upsert every buffered printing (base update onto the matched
 *   row, non-base create — ADD-ONLY, zero deletes), read after-counts, and run
 *   the per-set assertions (addendum MEDIUM-1: at most one base per number; net
 *   Card increase === non-base printings CREATED THIS RUN). A thrown upsert or a
 *   failed assertion rolls that set's transaction back and halts the run
 *   non-zero — the catalog is never left half-migrated (HARD CONSTRAINT).
 *
 * CREDIT GATING (load-bearing): `assertScrydexCreditsApproved("standard", pages)`
 * from `@/lib/services/scrydex-credit-gate` (NIT-1) runs BEFORE the first live
 * fetch on --apply (DENY by default — approve via SCRYDEX_LIVE_CREDITS_APPROVED
 * =true or the admin Redis flag). DRY RUN (default, no --apply) makes exactly
 * ONE gated page-1 fetch to read total_count + print a sample of the rows that
 * WOULD be written + the per-game credit estimate + before-counts — and NO
 * writes.
 *
 * POKEMON SET-NAME PRE-CHECK (addendum MEDIUM-1, HARD precondition): before
 * Pass 2 for --game=pokemon the script compares every seed Pokemon CardSet.name
 * against the Scrydex expansion names present in the Pass-1 buffer. If a seed
 * set name does not line up with a Scrydex expansion name (the match step would
 * green-field instead of reuse an existing row), the script REFUSES --apply and
 * exits non-zero listing the mismatches — unless --i-accept-set-name-miss is
 * passed. One Piece is exempt (its card.id IS the existing externalId).
 *
 * Usage (PowerShell — the repo path contains a space, always quote it):
 *   cd "d:\Pokemon\Pokemon\.worktrees\scrydex-parity-build"
 *   npx tsx scripts/reingest-per-printing.ts --game=onepiece             # DRY RUN
 *   # After owner approval + SCRYDEX_LIVE_CREDITS_APPROVED=true:
 *   npx tsx scripts/reingest-per-printing.ts --game=onepiece --apply
 *   npx tsx scripts/reingest-per-printing.ts --game=pokemon  --apply
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { Game, Prisma } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { redis } from "../src/lib/redis";
import {
  fetchScrydexCatalogPage,
  type ScrydexCard,
} from "../src/lib/services/scrydex.service";
import {
  assertScrydexCreditsApproved,
  estimateCredits,
} from "../src/lib/services/scrydex-credit-gate";
import { onePieceSetExternalId } from "../src/lib/utils/set-key";
import {
  mapScrydexCatalogCard,
  type MappedOnePieceCard,
  type MappedOnePiecePrice,
} from "./ingest-onepiece-catalog";
import {
  buildCardRows,
  buildPriceRows,
  type PokemonCardRow,
} from "./pull-full-catalog";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes("--apply");
const ACCEPT_SET_NAME_MISS = ARGS.includes("--i-accept-set-name-miss");
const PAGE_SIZE = 100;
const REQUEST_DELAY_MS = 250;

function parseGame(args: string[]): Game {
  const flag = args.find((a) => a.startsWith("--game="))?.split("=")[1]?.toLowerCase();
  if (flag === "onepiece") return Game.ONE_PIECE;
  if (flag === "pokemon") return Game.POKEMON;
  throw new Error("Pass --game=onepiece or --game=pokemon (One Piece first).");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Pure, testable seam (imported by the integration tests WITHOUT the runner)
// ---------------------------------------------------------------------------

/**
 * A buffered printing row (game-agnostic shape the orchestrator applies). Both
 * mappers' rows are projected onto this so the per-set apply + assertions are
 * written once. `externalId` is the final composite key, `isBase` is true when
 * the id has NO `::` suffix.
 */
export interface BufferedPrinting {
  externalId: string;
  baseId: string; // resolved existing externalId (Pokemon) or card.id
  number: string;
  printing: string;
  imageUrl: string | null;
  /** Full Card row for a Pokemon create/update (null for One Piece — OP writes via its own upsert). */
  pokemonRow: PokemonCardRow | null;
  /** The mapped One Piece card (null for Pokemon). */
  onePieceRow: MappedOnePieceCard | null;
  /** Price rows for this printing (already deduped by the mapper). */
  prices: BufferedPrice[];
}

export interface BufferedPrice {
  source: string;
  currency: string;
  variant: string;
  condition: string;
  company: string | null;
  grade: string | null;
  type: string;
  priceMarket: number | null;
  priceLow: number | null;
}

/** True when a composite externalId is the BASE printing (no `::` suffix). */
export function isBasePrinting(externalId: string): boolean {
  return !externalId.includes("::");
}

/**
 * The set grouping key used to bucket buffered printings in Pass 1 (addendum
 * HIGH-1). One Piece groups by the `onepiece-<slug>` set key derived from the
 * set NAME (FR-2.7 guard-rail); Pokemon groups by `pokemon-<exp.id>`.
 */
export function setGroupingKey(
  game: Game,
  input: { setName: string; expansionId: string | null }
): string | null {
  if (game === Game.ONE_PIECE) {
    const name = input.setName.trim();
    return name ? onePieceSetExternalId(name) : null;
  }
  // Pokemon: keyed by the Scrydex expansion id (same key pull-full-catalog uses).
  return input.expansionId ? `pokemon-${input.expansionId}` : null;
}

/**
 * Normalize a collector number for matching (mirrors
 * scrydex.service.resolveScrydexCard's private normNumber): strip any `/total`
 * suffix and leading zeros, lowercase.
 */
export function normNumber(n: string | null | undefined): string {
  if (!n) return "";
  const base = n.split("/")[0].trim();
  return base.replace(/^0+(?=\d)/, "").toLowerCase();
}

/** The minimal existing-row shape the Pokemon match step reads. */
export interface ExistingCardRow {
  externalId: string;
  number: string | null;
}

/**
 * The injected read-only finders the Pokemon baseId resolver uses (so tests
 * drive it with mocks, no live DB). `byScrydexId` mirrors
 * `findFirst(where scrydexId == c.id)`; `byGameSetNumber` mirrors
 * `findFirst(where game==G AND set.name==setName AND numberMatches)`.
 */
export interface BaseIdFinders {
  byScrydexId: (scrydexId: string) => Promise<ExistingCardRow | null>;
  byGameSetNumber: (
    setName: string,
    number: string
  ) => Promise<ExistingCardRow[]>;
}

/**
 * Resolve the Pokemon base printing's `externalId` by READ-ONLY
 * match-then-upsert (design.md §5.1): (1) a row whose `scrydexId == c.id`, else
 * (2) a row in the same game whose set NAME matches and whose collector number
 * matches (normNumber), else (3) green-field `baseId = c.id`. One Piece does NOT
 * call this — its card.id IS the existing externalId.
 */
export async function resolvePokemonBaseId(
  c: { id: string; number?: string | null },
  setName: string,
  finders: BaseIdFinders
): Promise<string> {
  // Step 1 — match by the Scrydex-native id (rows previously pulled).
  const byId = await finders.byScrydexId(c.id);
  if (byId) return byId.externalId;

  // Step 2 — match seed-provenance rows by set NAME + collector number.
  const want = normNumber(c.number);
  const candidates = await finders.byGameSetNumber(setName, want);
  const matched = candidates.find((r) => normNumber(r.number) === want);
  if (matched) return matched.externalId;

  // Step 3 — green-field: nothing to preserve.
  return c.id;
}

/** Per-set tallies accumulated while applying one set's buffered printings. */
export interface PerSetTallies {
  /** Card rows INSERTED this run whose externalId contains `::` (non-base). */
  createdNonBase: number;
  /** Card rows INSERTED this run whose externalId has NO `::` (base, green-field). */
  createdBase: number;
  updated: number;
  skipped: number;
}

export interface SetCounts {
  cardCount: number;
}

/**
 * Run the two per-set assertions (addendum MEDIUM-1), computed from THIS-RUN
 * tallies + the per-set before/after Card counts, INSIDE the set's transaction.
 * Throws (rolling the set's $transaction back) on any violation.
 *
 *   (1) duplicate-base: at most one base row per number in this set.
 *   (2) non-decreasing: after.cardCount >= before.cardCount (add-only).
 *   (3) net-increase === non-base CREATED THIS RUN:
 *       after.cardCount - before.cardCount === tallies.createdNonBase.
 *
 * (1) reads the final base-row-per-number tally for the set (a map built from
 * the buffered base printings keyed by number); a value > 1 means a double base.
 */
export function assertPerSetInvariants(
  setKey: string,
  before: SetCounts,
  after: SetCounts,
  tallies: PerSetTallies,
  baseRowsByNumber: Map<string, number>
): void {
  // (1) at most one base per number.
  for (const [number, count] of baseRowsByNumber) {
    if (count > 1) {
      throw new Error(
        `[reingest] set ${setKey}: duplicate base printing for number ${number} (${count} base rows) — assertion (1) failed`
      );
    }
  }

  // (2) add-only: Card count never decreases.
  if (after.cardCount < before.cardCount) {
    throw new Error(
      `[reingest] set ${setKey}: Card count decreased ${before.cardCount} -> ${after.cardCount} — assertion (2) failed`
    );
  }

  // (3) net increase equals non-base printings CREATED THIS RUN (re-run safe:
  // 0 === 0 on a clean second apply). A cross-set Pokemon set-name split lands
  // +N new rows here (1 green-field base + N-1 non-base) while createdNonBase is
  // only N-1 → fires.
  const netIncrease = after.cardCount - before.cardCount;
  if (netIncrease !== tallies.createdNonBase) {
    throw new Error(
      `[reingest] set ${setKey}: net Card increase ${netIncrease} !== non-base created this run ${tallies.createdNonBase} ` +
        `(created base this run=${tallies.createdBase}) — assertion (3) failed`
    );
  }
}

/**
 * Compare the seed Pokemon set names against the Scrydex expansion names in the
 * Pass-1 buffer (addendum MEDIUM-1 pre-check). Returns the seed set names that
 * do NOT line up with any Scrydex expansion name (case-insensitive) — a
 * non-empty result means the match step would green-field and --apply must
 * refuse unless --i-accept-set-name-miss is passed. One Piece never calls this.
 */
export function findSetNameMismatches(
  seedSetNames: string[],
  scrydexExpansionNames: string[]
): string[] {
  const known = new Set(
    scrydexExpansionNames.map((n) => n.trim().toLowerCase()).filter(Boolean)
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of seedSetNames) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (known.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Buffering (Pass 1 helpers — map a Scrydex card to buffered printings)
// ---------------------------------------------------------------------------

function onePieceToBuffered(card: ScrydexCard): BufferedPrinting[] {
  const rows = mapScrydexCatalogCard(card);
  return rows.map((m) => ({
    externalId: m.externalId,
    baseId: m.baseId,
    number: m.number,
    printing: m.printing,
    imageUrl: m.imageUrl,
    pokemonRow: null,
    onePieceRow: m,
    prices: m.prices.map((p: MappedOnePiecePrice) => ({ ...p })),
  }));
}

function pokemonToBuffered(
  card: ScrydexCard,
  baseId: string
): BufferedPrinting[] {
  // setId is resolved inside the transaction at apply time; buildCardRows needs
  // a placeholder here (Pass 1 only reads the composite ids/labels/prices). The
  // real setId is stamped in applyPokemonPrinting before the write.
  const rows = buildCardRows(
    card as unknown as Parameters<typeof buildCardRows>[0],
    "",
    Game.POKEMON,
    baseId
  );
  const variants = card.variants ?? [];
  return rows.map((r, i) => ({
    externalId: r.externalId,
    baseId,
    number: r.number,
    printing: r.printing,
    imageUrl: r.imageUrl,
    pokemonRow: r,
    onePieceRow: null,
    prices: variants[i]
      ? buildPriceRows(
          variants[i] as unknown as Parameters<typeof buildPriceRows>[0],
          "__pending__"
        )
      : [],
  }));
}

// ---------------------------------------------------------------------------
// Live runner (GUARDED — never imported/executed by tests)
// ---------------------------------------------------------------------------

interface RunReport {
  createdBase: number;
  createdNonBase: number;
  updated: number;
  skipped: number;
  invalid: number;
}

/** DB-identity print — avoid the local-vs-remote mixup before any write. */
async function printDbIdentity(): Promise<void> {
  const ident = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "select current_database() as db"
  );
  console.log(
    "[reingest] TARGET DB:",
    ident[0],
    "| host:",
    (process.env.DATABASE_URL ?? "").replace(/:[^:@/]+@/, ":****@")
  );
}

async function pageAndBuffer(
  game: Game,
  totalPages: number,
  firstPage: ScrydexCard[]
): Promise<{
  bySet: Map<string, BufferedPrinting[]>;
  scrydexExpansionNames: Set<string>;
  invalid: number;
}> {
  const bySet = new Map<string, BufferedPrinting[]>();
  const scrydexExpansionNames = new Set<string>();
  let invalid = 0;

  const absorb = async (cards: ScrydexCard[]): Promise<void> => {
    for (const card of cards) {
      const setName = (card.expansion?.name ?? "").trim();
      if (setName) scrydexExpansionNames.add(setName);
      const key = setGroupingKey(game, {
        setName,
        expansionId: card.expansion?.id ?? null,
      });
      if (!key) {
        invalid++;
        continue;
      }

      let buffered: BufferedPrinting[];
      if (game === Game.ONE_PIECE) {
        buffered = onePieceToBuffered(card);
      } else {
        const baseId = await resolvePokemonBaseId(card, setName, {
          byScrydexId: (scrydexId) =>
            prisma.card.findFirst({
              where: { scrydexId },
              select: { externalId: true, number: true },
            }),
          byGameSetNumber: (name, _num) =>
            prisma.card.findMany({
              where: { game: Game.POKEMON, set: { name } },
              select: { externalId: true, number: true },
            }),
        });
        buffered = pokemonToBuffered(card, baseId);
      }

      if (buffered.length === 0) {
        invalid++;
        continue;
      }
      const list = bySet.get(key) ?? [];
      list.push(...buffered);
      bySet.set(key, list);
    }
  };

  await absorb(firstPage);
  for (let p = 2; p <= totalPages; p++) {
    const page = await fetchScrydexCatalogPage(game, p, PAGE_SIZE);
    if (!page || page.cards.length === 0) {
      console.warn(`[reingest] page ${p} empty/failed — stopping Pass 1.`);
      break;
    }
    await absorb(page.cards);
    if (p < totalPages) await sleep(REQUEST_DELAY_MS);
  }

  return { bySet, scrydexExpansionNames, invalid };
}

/** Upsert ONE buffered One Piece printing inside a transaction. */
async function applyOnePiecePrinting(
  tx: Prisma.TransactionClient,
  b: BufferedPrinting
): Promise<"created" | "updated" | "skipped"> {
  const m = b.onePieceRow!;
  const cardSet = await tx.cardSet.upsert({
    where: { externalId: m.setExternalId },
    update: { name: m.setName },
    create: { externalId: m.setExternalId, name: m.setName },
  });

  const prior = await tx.card.findUnique({
    where: { externalId: m.externalId },
    select: {
      id: true,
      name: true,
      number: true,
      printing: true,
      rarity: true,
      types: true,
      imageUrl: true,
      marketPrice: true,
      setId: true,
    },
  });

  const base = {
    game: Game.ONE_PIECE,
    name: m.name,
    number: m.number,
    printing: m.printing,
    rarity: m.rarity,
    types: m.types,
    imageUrl: m.imageUrl,
    setId: cardSet.id,
    ...(m.marketPrice != null ? { marketPrice: m.marketPrice } : {}),
  };

  let cardId: string;
  let outcome: "created" | "updated" | "skipped";
  if (prior == null) {
    const created = await tx.card.create({
      data: { externalId: m.externalId, ...base },
      select: { id: true },
    });
    cardId = created.id;
    outcome = "created";
  } else {
    cardId = prior.id;
    const unchanged =
      prior.name === m.name &&
      prior.number === m.number &&
      prior.printing === m.printing &&
      prior.rarity === m.rarity &&
      prior.types.length === m.types.length &&
      prior.types.every((v, i) => v === m.types[i]) &&
      prior.imageUrl === m.imageUrl &&
      (m.marketPrice == null || prior.marketPrice === m.marketPrice) &&
      prior.setId === cardSet.id;
    if (unchanged) {
      outcome = "skipped";
    } else {
      await tx.card.update({ where: { externalId: m.externalId }, data: base });
      outcome = "updated";
    }
  }

  if (m.prices.length > 0) {
    await tx.currentPrice.deleteMany({
      where: { cardId, source: "SCRYDEX", variant: m.printing },
    });
    await tx.currentPrice.createMany({
      data: m.prices.map((p) => ({ cardId, ...p })),
      skipDuplicates: true,
    });
  }
  return outcome;
}

/** Upsert ONE buffered Pokemon printing inside a transaction (ADD-ONLY). */
async function applyPokemonPrinting(
  tx: Prisma.TransactionClient,
  b: BufferedPrinting,
  setId: string
): Promise<"created" | "updated" | "skipped"> {
  const r = b.pokemonRow!;
  const prior = await tx.card.findUnique({
    where: { externalId: r.externalId },
    select: {
      id: true,
      name: true,
      number: true,
      printing: true,
      rarity: true,
      types: true,
      imageUrl: true,
      imageUrlHi: true,
      marketPrice: true,
      setId: true,
    },
  });

  const data = {
    scrydexId: r.scrydexId,
    game: r.game,
    name: r.name,
    number: r.number,
    printing: r.printing,
    rarity: r.rarity,
    types: r.types,
    imageUrl: r.imageUrl,
    imageUrlHi: r.imageUrlHi,
    marketPrice: r.marketPrice,
    setId,
  };

  let cardId: string;
  let outcome: "created" | "updated" | "skipped";
  if (prior == null) {
    const created = await tx.card.create({
      data: { externalId: r.externalId, ...data },
      select: { id: true },
    });
    cardId = created.id;
    outcome = "created";
  } else {
    cardId = prior.id;
    const unchanged =
      prior.name === r.name &&
      prior.number === r.number &&
      prior.printing === r.printing &&
      prior.rarity === r.rarity &&
      prior.types.length === r.types.length &&
      prior.types.every((v, i) => v === r.types[i]) &&
      prior.imageUrl === r.imageUrl &&
      prior.imageUrlHi === r.imageUrlHi &&
      prior.marketPrice === r.marketPrice &&
      prior.setId === setId;
    if (unchanged) {
      outcome = "skipped";
    } else {
      await tx.card.update({ where: { externalId: r.externalId }, data });
      outcome = "updated";
    }
  }

  if (b.prices.length > 0) {
    await tx.currentPrice.deleteMany({
      where: { cardId, source: "SCRYDEX", variant: r.printing },
    });
    await tx.currentPrice.createMany({
      data: b.prices.map((p) => ({
        cardId,
        source: "SCRYDEX" as const,
        currency: p.currency,
        variant: p.variant,
        condition: p.condition,
        company: p.company,
        grade: p.grade,
        type: p.type,
        priceMarket: p.priceMarket,
        priceLow: p.priceLow,
      })),
      skipDuplicates: true,
    });
  }
  return outcome;
}

/** Flush the search caches after a successful --apply (best-effort, RULE 1). */
async function flushSearchCaches(): Promise<void> {
  try {
    for (const pattern of ["card:searchq:*", "card:search:*"]) {
      const keys: string[] = [];
      const stream = redis.scanStream({ match: pattern, count: 200 });
      await new Promise<void>((resolve, reject) => {
        stream.on("data", (batch: string[]) => keys.push(...batch));
        stream.on("end", resolve);
        stream.on("error", reject);
      });
      if (keys.length > 0) await redis.unlink(...keys);
      console.log(`[reingest] flushed ${keys.length} key(s) for ${pattern}`);
    }
  } catch (err) {
    // RULE 1 — Redis is a pure cache; a flush failure never fails the run.
    console.warn(
      "[reingest] search-cache flush failed (non-fatal):",
      err instanceof Error ? err.message : err
    );
  }
}

async function run(): Promise<void> {
  const game = parseGame(ARGS);
  const label = game === Game.ONE_PIECE ? "onepiece" : "pokemon";
  await printDbIdentity();

  // One gated page-1 fetch (both dry-run + apply need total_count first).
  await assertScrydexCreditsApproved("standard", 1);
  const first = await fetchScrydexCatalogPage(game, 1, PAGE_SIZE);
  if (!first) {
    console.warn(`[reingest] ${label}: page-1 fetch failed (no data). Aborting.`);
    return;
  }
  const total = first.totalCount ?? first.cards.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const estimate = estimateCredits("standard", pages);

  if (!APPLY) {
    const sampleBuffered =
      game === Game.ONE_PIECE
        ? first.cards.slice(0, 5).flatMap(onePieceToBuffered)
        : first.cards
            .slice(0, 5)
            .flatMap((c) =>
              pokemonToBuffered(c, c.id /* dry-run: show green-field ids */)
            );
    console.log(`[reingest] DRY RUN (${label}) — NO writes.`);
    console.log(`[reingest] total_count=${total} → up to ${pages} page(s) ≈ ${estimate} credit(s).`);
    console.log("[reingest] sample rows that WOULD be written:");
    for (const b of sampleBuffered.slice(0, 10)) {
      console.log(`  ${b.externalId}  printing="${b.printing}"  img=${b.imageUrl ? "yes" : "—"}`);
    }
    const before = await prisma.card.count({ where: { game } });
    console.log(`[reingest] before: Card(game=${label})=${before}. Re-run with --apply (owner-approved).`);
    return;
  }

  // --- APPLY ---
  console.log(`[reingest] APPLY (${label}) — up to ${pages} page(s) ≈ ${estimate} credit(s).`);
  await assertScrydexCreditsApproved("standard", pages);

  // Pass 1 — page + buffer (+ Pokemon baseId resolution).
  const { bySet, scrydexExpansionNames, invalid } = await pageAndBuffer(
    game,
    pages,
    first.cards
  );
  console.log(
    `[reingest] Pass 1 buffered ${[...bySet.values()].reduce((n, l) => n + l.length, 0)} ` +
      `printing(s) across ${bySet.size} set(s); invalid=${invalid}.`
  );

  // Pokemon HARD pre-check (addendum MEDIUM-1) — refuse on a set-name miss.
  if (game === Game.POKEMON) {
    const seedSets = await prisma.cardSet.findMany({
      where: { cards: { some: { game: Game.POKEMON } } },
      select: { name: true },
    });
    const mismatches = findSetNameMismatches(
      seedSets.map((s) => s.name),
      [...scrydexExpansionNames]
    );
    if (mismatches.length > 0 && !ACCEPT_SET_NAME_MISS) {
      console.error(
        `[reingest] REFUSING --apply: ${mismatches.length} Pokemon seed set name(s) do NOT line up ` +
          `with a Scrydex expansion name (the match step would green-field, splitting a number across sets):`
      );
      for (const m of mismatches) console.error(`  - ${m}`);
      console.error(
        "[reingest] Reconcile Pokemon set names first, or pass --i-accept-set-name-miss to override."
      );
      process.exitCode = 1;
      return;
    }
  }

  // Before-counts (whole run — AC-8/AC-10).
  const beforeCard = await prisma.card.count({ where: { game } });
  const beforePrice = await prisma.currentPrice.count();
  const beforeOwned = await prisma.userCollection.count();

  const report: RunReport = {
    createdBase: 0,
    createdNonBase: 0,
    updated: 0,
    skipped: 0,
    invalid,
  };

  // Pass 2 — per-set transactional flush.
  for (const [setKey, printings] of bySet) {
    try {
      await prisma.$transaction(async (tx) => {
        // Resolve the parent CardSet id once for a Pokemon set (One Piece upserts
        // its own set per printing). Pokemon rows all share the Scrydex expansion.
        let pokemonSetId = "";
        if (game === Game.POKEMON) {
          const expId = setKey.replace(/^pokemon-/, "");
          const set = await tx.cardSet.upsert({
            where: { externalId: setKey },
            update: {},
            create: { externalId: setKey, name: expId },
          });
          pokemonSetId = set.id;
        }

        // The set unit = the CardSet rows. For before/after we count rows whose
        // setId is this set (One Piece: resolved on first upsert below; Pokemon:
        // pokemonSetId). We read before-count AFTER the set row exists.
        const setIdForCount =
          game === Game.POKEMON
            ? pokemonSetId
            : (
                await tx.cardSet.findUnique({
                  where: {
                    externalId:
                      printings[0].onePieceRow?.setExternalId ?? setKey,
                  },
                  select: { id: true },
                })
              )?.id ?? null;

        const before: SetCounts = {
          cardCount: setIdForCount
            ? await tx.card.count({ where: { setId: setIdForCount } })
            : 0,
        };

        const tallies: PerSetTallies = {
          createdNonBase: 0,
          createdBase: 0,
          updated: 0,
          skipped: 0,
        };

        // Dedupe printings by their final externalId within the set. The same
        // physical card can appear twice in the buffered set when the set-
        // reconcile merged two source expansions (e.g. a main set + a
        // tournament/promo sub-set) that both contain the same Bandai number —
        // Scrydex returns both, each mapping to the same base externalId. They
        // are the SAME card, not two base rows: keep the first occurrence so a
        // legitimate source-level duplicate doesn't trip assertion (1).
        const seenExt = new Set<string>();
        const dedupedPrintings = printings.filter((b) => {
          if (seenExt.has(b.externalId)) return false;
          seenExt.add(b.externalId);
          return true;
        });

        for (const b of dedupedPrintings) {
          const outcome =
            game === Game.ONE_PIECE
              ? await applyOnePiecePrinting(tx, b)
              : await applyPokemonPrinting(tx, b, pokemonSetId);
          if (outcome === "created") {
            if (isBasePrinting(b.externalId)) tallies.createdBase++;
            else tallies.createdNonBase++;
          } else if (outcome === "updated") tallies.updated++;
          else tallies.skipped++;
        }

        // Final set id (One Piece set is created during the loop).
        const finalSetId =
          setIdForCount ??
          (
            await tx.cardSet.findUnique({
              where: {
                externalId: printings[0].onePieceRow?.setExternalId ?? setKey,
              },
              select: { id: true },
            })
          )?.id ??
          null;

        const after: SetCounts = {
          cardCount: finalSetId
            ? await tx.card.count({ where: { setId: finalSetId } })
            : before.cardCount + tallies.createdBase + tallies.createdNonBase,
        };

        // Base-rows-per-number tally for assertion (1) — computed from the
        // SAME deduped list the apply loop used (a source-level duplicate base
        // is one card, not two).
        const baseRowsByNumber = new Map<string, number>();
        for (const b of dedupedPrintings) {
          if (isBasePrinting(b.externalId)) {
            baseRowsByNumber.set(
              b.number,
              (baseRowsByNumber.get(b.number) ?? 0) + 1
            );
          }
        }

        assertPerSetInvariants(setKey, before, after, tallies, baseRowsByNumber);

        report.createdBase += tallies.createdBase;
        report.createdNonBase += tallies.createdNonBase;
        report.updated += tallies.updated;
        report.skipped += tallies.skipped;
        console.log(
          `[reingest] set ${setKey}: before=${before.cardCount} after=${after.cardCount} ` +
            `(+base ${tallies.createdBase} +nonBase ${tallies.createdNonBase} upd ${tallies.updated} skip ${tallies.skipped})`
        );
      }, {
        // A large set (hundreds of printings × price rows) over the remote
        // Mumbai direct connection can exceed Prisma's 5s default. Give each
        // per-set transaction a generous ceiling; maxWait covers pool acquire.
        timeout: 120_000,
        maxWait: 20_000,
      });
    } catch (err) {
      console.error(
        `[reingest] set ${setKey} FAILED — transaction rolled back. Halting.`,
        err instanceof Error ? err.message : err
      );
      process.exitCode = 1;
      return;
    }
  }

  // After-counts + owned-count invariant (AC-10).
  const afterCard = await prisma.card.count({ where: { game } });
  const afterPrice = await prisma.currentPrice.count();
  const afterOwned = await prisma.userCollection.count();
  if (afterOwned !== beforeOwned) {
    console.error(
      `[reingest] FATAL: UserCollection count changed ${beforeOwned} -> ${afterOwned} (expected unchanged, AC-10).`
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[reingest] APPLY done (${label}). Card ${beforeCard}->${afterCard} ` +
      `CurrentPrice ${beforePrice}->${afterPrice} UserCollection ${beforeOwned}->${afterOwned} (unchanged). ` +
      `createdBase=${report.createdBase} createdNonBase=${report.createdNonBase} ` +
      `updated=${report.updated} skipped=${report.skipped} invalid=${report.invalid}.`
  );

  // End-of-run: flush search caches so reads repopulate per-printing (§6.1).
  await flushSearchCaches();
}

// Guarded live runner — NEVER fires on import (tests import the pure seam only).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
