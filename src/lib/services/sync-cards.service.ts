/**
 * Daily Sync Engine — pulls sets + cards from external TCG APIs into
 * our local Supabase catalog. The user-facing search route then reads
 * exclusively from Supabase, so:
 *
 *   - Searches are instant (no external HTTP on the hot path).
 *   - External APIs are only ever hit by this scheduled job, not by
 *     every user typing in the search box — no API bans.
 *
 * -----------------------------------------------------------------
 * ID / prefix convention (must match the rest of the app)
 * -----------------------------------------------------------------
 * `CardSet.externalId` is prefixed with the game key so we can filter
 * "pokemon-only" and "onepiece-only" cards by joining through the set.
 * That convention is baked into /api/cards/trending, admin/cards, the
 * seed script, etc., so we preserve it here:
 *
 *   pokemon set   → externalId = `pokemon-{sourceSetId}` (e.g. "pokemon-base1")
 *   onepiece set  → externalId = `onepiece-{sourceSetId}`
 *
 * `Card.externalId` is the raw source id (e.g. `base1-4`, `OP01-001`)
 * so it stays stable across syncs and matches URLs users have already
 * bookmarked.
 *
 * -----------------------------------------------------------------
 * Budgeting
 * -----------------------------------------------------------------
 * Vercel Hobby caps functions at 60s and Pro at 300s. We cap this
 * invocation at `MAX_SETS_PER_RUN` sets (default 5) and enforce a
 * wall-clock budget so we always return cleanly before the platform
 * kills us. Anything not processed today will be picked up tomorrow;
 * the sync is idempotent (upserts everywhere).
 */

import { prisma } from "@/lib/db";
import { buildTags } from "@/lib/utils/card-tags";
import { pickPokemonMarketPrice } from "@/lib/utils/card-price";
import { isOnePieceCode } from "@/lib/utils/card-image";
import { resolveOnePieceCleanImage } from "@/lib/utils/card-image.server";

/**
 * Resolves a clean (non-"SAMPLE") One Piece image on import when a licensed
 * source is configured, else returns the source URL unchanged. Never throws —
 * a resolver failure just keeps the original image so the sync never breaks.
 */
async function cleanImageOnImport(
  code: string,
  sourceUrl: string | null | undefined
): Promise<string | null | undefined> {
  // Skip the network call entirely when no clean source is configured.
  if (!process.env.TCGCOLLECTOR_API_KEY && !process.env.CARDMARKET_APP_TOKEN) {
    return sourceUrl;
  }
  try {
    return (await resolveOnePieceCleanImage(code)) ?? sourceUrl;
  } catch {
    return sourceUrl;
  }
}

// -----------------------------------------------------------------
// Types
// -----------------------------------------------------------------

export type Game = "pokemon" | "onepiece";

export interface SyncCardInput {
  externalId: string;         // e.g. "base1-4"
  name: string;
  number: string;             // printed number ("4/102" or "OP01-001")
  rarity?: string | null;
  types?: string[];
  imageUrl?: string | null;
  imageUrlHi?: string | null;
  marketPrice?: number | null;
}

export interface SyncSetInput {
  sourceSetId: string;        // e.g. "base1"
  name: string;
  series?: string | null;
  printedTotal?: number | null;
  total?: number | null;
  releaseDate?: Date | null;
  symbolUrl?: string | null;
  logoUrl?: string | null;
}

export interface SyncSetSummary {
  game: Game;
  sourceSetId: string;
  setName: string;
  cardsUpserted: number;
  durationMs: number;
  skipped?: string;           // reason if we chose not to sync
  error?: string;
}

export interface SyncRunSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  setsConsidered: number;
  setsProcessed: number;
  cardsUpserted: number;
  perSet: SyncSetSummary[];
  errors: string[];
}

// -----------------------------------------------------------------
// Config
// -----------------------------------------------------------------

const MAX_SETS_PER_RUN = 10;
const STALE_AFTER_DAYS = 7;
const REQUEST_DELAY_MS = 600;         // between external HTTP calls
// Wall-clock cap. Vercel Pro allows 300s; we stop at 250s so we finish
// upserting cards already in flight and return a clean summary rather
// than getting SIGKILL'd by the platform mid-write.
const RUN_BUDGET_MS = 250_000;
// Card upserts are DB round-trips (~50-100ms each over Supabase pooler),
// so serial upserts made one big set take ~100 seconds. Running them in
// parallel chunks brings that to single-digit seconds while staying
// well below Supabase's pooled-connection limit.
const UPSERT_CONCURRENCY = 10;

// -----------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------

export async function runCardSync(): Promise<SyncRunSummary> {
  const startedAt = new Date();
  const summary: SyncRunSummary = {
    startedAt: startedAt.toISOString(),
    finishedAt: "",
    durationMs: 0,
    setsConsidered: 0,
    setsProcessed: 0,
    cardsUpserted: 0,
    perSet: [],
    errors: [],
  };

  const activeIdsFromCollections = (await prisma.card.findMany({
    where: { userCollections: { some: {} } },
    select: { externalId: true }
  })).map(c => c.externalId);
  
  const activeIdsFromWants = (await prisma.wantListItem.findMany({
    select: { cardId: true }
  })).map(c => c.cardId);

  const activeCardExternalIds = new Set([...activeIdsFromCollections, ...activeIdsFromWants]);

  // 1. Discover candidate sets across both games in parallel.
  const [pokemonSets, onepieceSets] = await Promise.all([
    safelyListSets("pokemon"),
    safelyListSets("onepiece"),
  ]);

  const allCandidates: Array<{ game: Game; set: SyncSetInput }> = [
    ...pokemonSets.map((set) => ({ game: "pokemon" as const, set })),
    ...onepieceSets.map((set) => ({ game: "onepiece" as const, set })),
  ];
  summary.setsConsidered = allCandidates.length;

  if (allCandidates.length === 0) {
    summary.errors.push("Both source APIs returned zero sets");
    return finalise(summary, startedAt);
  }

  // 2. Filter down to sets that are missing or older than STALE_AFTER_DAYS.
  const dueSets = await filterSetsDueForSync(allCandidates);

  // 3. Process the first N due sets, in the order the source APIs returned
  //    them (which is roughly newest-first for pokemontcg.io). Prefer
  //    interleaving Pokemon / One Piece so a stalled source doesn't
  //    starve the other game.
  const queue = interleaveByGame(dueSets).slice(0, MAX_SETS_PER_RUN);

  const deadline = startedAt.getTime() + RUN_BUDGET_MS;

  for (const { game, set } of queue) {
    if (Date.now() > deadline) {
      summary.errors.push("Wall-clock budget reached; remaining sets deferred to next run");
      break;
    }

    const setSummary = await syncOneSet(game, set, deadline, activeCardExternalIds);
    summary.perSet.push(setSummary);
    if (!setSummary.skipped) {
      summary.setsProcessed += 1;
      summary.cardsUpserted += setSummary.cardsUpserted;
    }
    if (setSummary.error) summary.errors.push(setSummary.error);

    await sleep(REQUEST_DELAY_MS);
  }

  return finalise(summary, startedAt);
}

// -----------------------------------------------------------------
// Set discovery
// -----------------------------------------------------------------

async function safelyListSets(game: Game): Promise<SyncSetInput[]> {
  try {
    if (game === "pokemon") return await listPokemonSets();
    return await listOnePieceSets();
  } catch (err) {
    console.error(
      `[sync-cards] Failed to list sets for ${game}:`,
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

async function filterSetsDueForSync(
  candidates: Array<{ game: Game; set: SyncSetInput }>
): Promise<Array<{ game: Game; set: SyncSetInput }>> {
  const externalIds = candidates.map(
    ({ game, set }) => `${game}-${set.sourceSetId}`
  );
  const existing = await prisma.cardSet.findMany({
    where: { externalId: { in: externalIds } },
    select: { externalId: true, updatedAt: true },
  });
  const byId = new Map(existing.map((s) => [s.externalId, s.updatedAt]));
  const staleCutoff = Date.now() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;

  return candidates.filter(({ game, set }) => {
    const id = `${game}-${set.sourceSetId}`;
    const updatedAt = byId.get(id);
    if (!updatedAt) return true;                    // missing → sync
    return updatedAt.getTime() < staleCutoff;       // stale → sync
  });
}

function interleaveByGame<T extends { game: Game }>(items: T[]): T[] {
  const pokemon = items.filter((i) => i.game === "pokemon");
  const onepiece = items.filter((i) => i.game === "onepiece");
  const out: T[] = [];
  const max = Math.max(pokemon.length, onepiece.length);
  for (let i = 0; i < max; i++) {
    if (i < pokemon.length) out.push(pokemon[i]);
    if (i < onepiece.length) out.push(onepiece[i]);
  }
  return out;
}

// -----------------------------------------------------------------
// Sync one set
// -----------------------------------------------------------------

async function syncOneSet(
  game: Game,
  set: SyncSetInput,
  deadline: number,
  activeCardExternalIds: Set<string>
): Promise<SyncSetSummary> {
  const setStartedAt = Date.now();
  const setExternalId = `${game}-${set.sourceSetId}`;
  const base: SyncSetSummary = {
    game,
    sourceSetId: set.sourceSetId,
    setName: set.name,
    cardsUpserted: 0,
    durationMs: 0,
  };

  try {
    // Fetch cards from the source FIRST. If this throws (upstream 5xx,
    // rate limit, network hiccup) we bail before touching any DB row,
    // which leaves the set looking "missing" to filterSetsDueForSync
    // and guarantees a retry on the next run. Doing the set-upsert
    // first would refresh its `updatedAt` and hide the failure behind
    // the 7-day staleness window.
    const cards =
      game === "pokemon"
        ? await listPokemonCardsInSet(set.sourceSetId, activeCardExternalIds)
        : await listOnePieceCardsInSet(set.sourceSetId);

    // Only now that we have real card data, upsert the parent CardSet.
    const dbSet = await prisma.cardSet.upsert({
      where: { externalId: setExternalId },
      update: {
        name: set.name,
        series: set.series ?? undefined,
        printedTotal: set.printedTotal ?? undefined,
        total: set.total ?? undefined,
        releaseDate: set.releaseDate ?? undefined,
        symbolUrl: set.symbolUrl ?? undefined,
        logoUrl: set.logoUrl ?? undefined,
      },
      create: {
        externalId: setExternalId,
        name: set.name,
        series: set.series ?? null,
        printedTotal: set.printedTotal ?? null,
        total: set.total ?? null,
        releaseDate: set.releaseDate ?? null,
        symbolUrl: set.symbolUrl ?? null,
        logoUrl: set.logoUrl ?? null,
      },
      select: { id: true },
    });

    // Upsert cards in parallel chunks. Each upsert is a Supabase round
    // trip (~50-100ms via the pooler); serial writes made a 120-card
    // set take ~100 seconds. Concurrency of 10 stays comfortably under
    // Supabase's pooled connection ceiling while cutting wall time to
    // single-digit seconds. Between chunks we re-check the wall-clock
    // budget so a fat set can gracefully hand off remaining cards to
    // the next run instead of getting SIGKILL'd mid-write.
    for (let i = 0; i < cards.length; i += UPSERT_CONCURRENCY) {
      if (Date.now() > deadline) {
        base.error = `Wall-clock budget reached partway through "${set.name}" (${base.cardsUpserted}/${cards.length} cards). Remainder will be picked up next run.`;
        break;
      }
      const chunk = cards.slice(i, i + UPSERT_CONCURRENCY);
      await Promise.all(chunk.map((card) => upsertCard(card, dbSet.id, set.name)));
      base.cardsUpserted += chunk.length;
    }
  } catch (err) {
    base.error =
      err instanceof Error ? err.message : `Unknown error syncing ${setExternalId}`;
    console.error(`[sync-cards] Failed to sync ${setExternalId}:`, err);
  }

  base.durationMs = Date.now() - setStartedAt;
  return base;
}

// Single-card upsert extracted so the parallel chunker stays readable.
async function upsertCard(card: SyncCardInput, setId: string, setName: string): Promise<void> {
  // Searchable keyword tags from the card/set metadata (same helper the
  // seed + one-off backfill use), so cards the daily cron imports are
  // searchable-by-tag immediately — no separate backfill needed.
  const tags = buildTags({
    rarity: card.rarity ?? null,
    types: card.types ?? [],
    number: card.number,
    set: { name: setName, series: null },
  });

  // One Piece images from the source (apitcg → TCGplayer CDN) carry a
  // "SAMPLE" watermark. If a licensed clean source is configured, resolve a
  // clean URL here so the DAILY CRON stores clean art on import — no separate
  // backfill needed. cleanImageOnImport() is a no-op (returns the given URL)
  // when no key is set, so this adds zero cost to the common case.
  const cleanImage = isOnePieceCode(card.externalId)
    ? await cleanImageOnImport(card.externalId, card.imageUrl)
    : card.imageUrl;

  await prisma.card.upsert({
    where: { externalId: card.externalId },
    update: {
      name: card.name,
      number: card.number,
      rarity: card.rarity ?? undefined,
      types: card.types ?? undefined,
      tags,
      imageUrl: cleanImage ?? undefined,
      imageUrlHi: card.imageUrlHi ?? undefined,
      ...(card.marketPrice != null
        ? { marketPrice: card.marketPrice, lastPricedAt: new Date() }
        : {}),
      setId,
    },
    create: {
      externalId: card.externalId,
      name: card.name,
      number: card.number,
      rarity: card.rarity ?? null,
      types: card.types ?? [],
      tags,
      imageUrl: cleanImage ?? null,
      imageUrlHi: card.imageUrlHi ?? null,
      marketPrice: card.marketPrice ?? null,
      lastPricedAt: card.marketPrice != null ? new Date() : null,
      setId,
    },
  });
}

// =================================================================
// Pokémon adapter — pokemontcg.io
// =================================================================
// Docs: https://docs.pokemontcg.io/
// Authentication is optional; an API key raises rate limits from 30/min
// to 20,000/day. Sent as `X-Api-Key`. Add POKEMON_TCG_API_KEY to .env
// for production runs.

import { fetchSets as fetchTcgDexSets, fetchCardsBySet as fetchTcgDexCards } from "./tcgdex.service";
import { fetchPokemonCardPrice } from "./pokewallet.service";

async function listPokemonSets(): Promise<SyncSetInput[]> {
  const sets = await fetchTcgDexSets();
  return sets.map(s => ({
    sourceSetId: s.id,
    name: s.name,
    series: null,
    printedTotal: s.cardCount?.official ?? null,
    total: s.cardCount?.total ?? null,
    releaseDate: s.releaseDate ? new Date(s.releaseDate) : null,
    symbolUrl: s.symbol ? `${s.symbol}.png` : null,
    logoUrl: s.logo ? `${s.logo}.png` : null,
  }));
}

async function listPokemonCardsInSet(
  sourceSetId: string,
  activeCardExternalIds: Set<string>
): Promise<SyncCardInput[]> {
  const cards = await fetchTcgDexCards(sourceSetId);
  const collected: SyncCardInput[] = [];

  for (const c of cards) {
    if (!c.id || !c.name) continue;
    
    // Fetch price fallback from PokeWallet only if card is active
    const isActive = activeCardExternalIds.has(c.id);
    let price = null;
    if (isActive) {
      price = await fetchPokemonCardPrice(c.id);
      await sleep(REQUEST_DELAY_MS);
    }

    collected.push({
      externalId: c.id,
      name: c.name,
      number: c.localId ?? "",
      rarity: c.rarity ?? null,
      types: c.category ? [c.category] : [],
      imageUrl: c.image ? `${c.image}/low.webp` : null,
      imageUrlHi: c.image ? `${c.image}/high.webp` : null,
      marketPrice: price?.marketPrice ?? null,
    });
  }

  return collected;
}

// =================================================================
// One Piece adapter — apitcg.com
// =================================================================
// Same source we already use for user search (see card.service.ts).
// TCGdex was tried first but only hosts Pokémon.
//
// Auth   : `x-api-key: $APITCG_API_KEY` header (required).
// Sets   : GET https://api.apitcg.com/api/one-piece/sets
//          → { success, data: [{ _id, name, code, release_date }] }
// Cards  : GET https://api.apitcg.com/api/products?tcg=one-piece&set={slug}&limit=500
//          → { success, data: [{ code, name, images, markets.tcgplayer.prices.market,
//                                 attributes: { Rarity, Number, Color, CardType, ... } }],
//              total }
//
// We use `_id` (the slug like "one-piece-romance-dawn") as our
// sourceSetId — that's what the /products endpoint's `set=` filter
// expects. `code` ("OP07") is displayed but not used for filtering.

import { fetchOnePieceSets as fetchPWOnePieceSets, fetchOnePieceCards as fetchPWOnePieceCards } from "./pokewallet.service";

async function listOnePieceSets(): Promise<SyncSetInput[]> {
  const sets = await fetchPWOnePieceSets();
  return sets.map(s => ({
    sourceSetId: s.id,
    name: s.name,
    series: "One Piece Card Game",
    releaseDate: s.releaseDate ? new Date(s.releaseDate) : null,
  }));
}

async function listOnePieceCardsInSet(
  sourceSetId: string
): Promise<SyncCardInput[]> {
  const cards = await fetchPWOnePieceCards(sourceSetId);
  return cards.map(c => ({
    externalId: c.id,
    name: c.name,
    number: c.number ?? c.id,
    rarity: c.rarity ?? null,
    types: c.types ?? [],
    imageUrl: c.image ?? null,
    imageUrlHi: c.imageHi ?? null,
    marketPrice: c.marketPrice ?? null,
  }));
}

// -----------------------------------------------------------------
// Utils
// -----------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function finalise(summary: SyncRunSummary, startedAt: Date): SyncRunSummary {
  const finished = new Date();
  summary.finishedAt = finished.toISOString();
  summary.durationMs = finished.getTime() - startedAt.getTime();
  return summary;
}
