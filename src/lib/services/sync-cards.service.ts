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

const MAX_SETS_PER_RUN = 6;
const STALE_AFTER_DAYS = 7;
const REQUEST_DELAY_MS = 600;         // between external HTTP calls
const RUN_BUDGET_MS = 55_000;         // wall-clock cap (Hobby-safe)

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

  for (const { game, set } of queue) {
    if (Date.now() - startedAt.getTime() > RUN_BUDGET_MS) {
      summary.errors.push("Wall-clock budget reached; remaining sets deferred to next run");
      break;
    }

    const setSummary = await syncOneSet(game, set);
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
  set: SyncSetInput
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
    // Upsert the parent CardSet FIRST so we have a stable FK target.
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

    // Rate-limit the external card fetch as well.
    await sleep(REQUEST_DELAY_MS);
    const cards =
      game === "pokemon"
        ? await listPokemonCardsInSet(set.sourceSetId)
        : await listOnePieceCardsInSet(set.sourceSetId);

    // Upsert cards sequentially to avoid connection storms against
    // Supabase's pooled connection.
    for (const card of cards) {
      await prisma.card.upsert({
        where: { externalId: card.externalId },
        update: {
          name: card.name,
          number: card.number,
          rarity: card.rarity ?? undefined,
          types: card.types ?? undefined,
          imageUrl: card.imageUrl ?? undefined,
          imageUrlHi: card.imageUrlHi ?? undefined,
          ...(card.marketPrice != null
            ? { marketPrice: card.marketPrice, lastPricedAt: new Date() }
            : {}),
          setId: dbSet.id,
        },
        create: {
          externalId: card.externalId,
          name: card.name,
          number: card.number,
          rarity: card.rarity ?? null,
          types: card.types ?? [],
          imageUrl: card.imageUrl ?? null,
          imageUrlHi: card.imageUrlHi ?? null,
          marketPrice: card.marketPrice ?? null,
          lastPricedAt: card.marketPrice != null ? new Date() : null,
          setId: dbSet.id,
        },
      });
      base.cardsUpserted += 1;
    }
  } catch (err) {
    base.error =
      err instanceof Error ? err.message : `Unknown error syncing ${setExternalId}`;
    console.error(`[sync-cards] Failed to sync ${setExternalId}:`, err);
  }

  base.durationMs = Date.now() - setStartedAt;
  return base;
}

// =================================================================
// Pokémon adapter — pokemontcg.io
// =================================================================
// Docs: https://docs.pokemontcg.io/
// Authentication is optional; an API key raises rate limits from 30/min
// to 20,000/day. Sent as `X-Api-Key`. Add POKEMON_TCG_API_KEY to .env
// for production runs.

interface PokemonTcgSet {
  id?: string;
  name?: string;
  series?: string;
  printedTotal?: number;
  total?: number;
  releaseDate?: string;
  images?: { symbol?: string; logo?: string };
}
interface PokemonTcgSetsResponse {
  data?: PokemonTcgSet[];
}
interface PokemonTcgCard {
  id?: string;
  name?: string;
  number?: string;
  rarity?: string;
  types?: string[];
  images?: { small?: string; large?: string };
  tcgplayer?: {
    prices?: Record<
      string,
      { market?: number }
    >;
  };
}
interface PokemonTcgCardsResponse {
  data?: PokemonTcgCard[];
  page?: number;
  pageSize?: number;
  count?: number;
  totalCount?: number;
}

function pokemonHeaders(): HeadersInit {
  const key = process.env.POKEMON_TCG_API_KEY;
  return key ? { "X-Api-Key": key } : {};
}

async function listPokemonSets(): Promise<SyncSetInput[]> {
  const res = await fetch("https://api.pokemontcg.io/v2/sets", {
    headers: pokemonHeaders(),
    // Sets change rarely — Vercel's edge cache doesn't apply to node
    // fetch here, but we don't need one anyway (called once per run).
  });
  if (!res.ok) {
    throw new Error(`pokemontcg /sets HTTP ${res.status}`);
  }
  const payload = (await res.json()) as PokemonTcgSetsResponse;
  const sets = payload.data ?? [];
  return sets
    .filter((s): s is PokemonTcgSet & { id: string; name: string } =>
      Boolean(s.id && s.name)
    )
    // Newest first — recent sets are what users search for most.
    .sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""))
    .map((s) => ({
      sourceSetId: s.id,
      name: s.name,
      series: s.series ?? null,
      printedTotal: s.printedTotal ?? null,
      total: s.total ?? null,
      releaseDate: s.releaseDate ? new Date(s.releaseDate) : null,
      symbolUrl: s.images?.symbol ?? null,
      logoUrl: s.images?.logo ?? null,
    }));
}

async function listPokemonCardsInSet(
  sourceSetId: string
): Promise<SyncCardInput[]> {
  const collected: SyncCardInput[] = [];
  let page = 1;
  const pageSize = 250;

  // Each set's card count varies — 100 to ~250 for modern sets. Loop
  // until we've drained every page.
  while (true) {
    const url =
      `https://api.pokemontcg.io/v2/cards?q=set.id:${encodeURIComponent(sourceSetId)}` +
      `&pageSize=${pageSize}&page=${page}`;
    const res = await fetch(url, { headers: pokemonHeaders() });
    if (!res.ok) {
      throw new Error(
        `pokemontcg /cards HTTP ${res.status} for set ${sourceSetId} page ${page}`
      );
    }
    const payload = (await res.json()) as PokemonTcgCardsResponse;
    const list = payload.data ?? [];

    for (const c of list) {
      if (!c.id || !c.name) continue;
      collected.push({
        externalId: c.id,
        name: c.name,
        number: c.number ?? "",
        rarity: c.rarity ?? null,
        types: c.types ?? [],
        imageUrl: c.images?.small ?? null,
        imageUrlHi: c.images?.large ?? null,
        marketPrice: pickTcgplayerMarket(c.tcgplayer?.prices),
      });
    }

    if (list.length < pageSize) break;  // last page
    page += 1;
    await sleep(REQUEST_DELAY_MS);      // rate limit between pages
  }

  return collected;
}

function pickTcgplayerMarket(
  prices?: Record<string, { market?: number } | undefined>
): number | null {
  if (!prices) return null;
  for (const variant of Object.values(prices)) {
    if (variant && typeof variant.market === "number" && !Number.isNaN(variant.market)) {
      return variant.market;
    }
  }
  return null;
}

// =================================================================
// One Piece adapter — TCGdex
// =================================================================
// Docs: https://tcgdex.dev/
// TCGdex covers multiple TCGs including One Piece. Free, no key.
// The series slug is `op` for One Piece Card Game.
//
// Sets list :  GET https://api.tcgdex.net/v2/en/series/op
//   returns { id, name, sets: [{ id, name, cardCount: { total, official } }] }
// Set detail: GET https://api.tcgdex.net/v2/en/sets/{setId}
//   returns { id, name, cards: [{ id, localId, name, image }] }
// Card detail (optional): GET https://api.tcgdex.net/v2/en/cards/{cardId}
//
// TCGdex does NOT expose market prices — cards synced from here will
// have marketPrice = null. That's fine; the price-comparison feature
// falls back to eBay lookups anyway.

interface TcgdexSeries {
  id?: string;
  name?: string;
  sets?: Array<{
    id?: string;
    name?: string;
    cardCount?: { total?: number; official?: number };
    releaseDate?: string;
    symbol?: string;
    logo?: string;
  }>;
}

interface TcgdexSetDetail {
  id?: string;
  name?: string;
  releaseDate?: string;
  cardCount?: { total?: number; official?: number };
  symbol?: string;
  logo?: string;
  cards?: Array<{
    id?: string;
    localId?: string;
    name?: string;
    image?: string;
    rarity?: string;
  }>;
}

async function listOnePieceSets(): Promise<SyncSetInput[]> {
  const res = await fetch("https://api.tcgdex.net/v2/en/series/op");
  if (!res.ok) {
    // TCGdex may not yet host One Piece under this slug in every env —
    // fail soft so the Pokemon sync keeps working.
    throw new Error(`tcgdex /series/op HTTP ${res.status}`);
  }
  const payload = (await res.json()) as TcgdexSeries;
  const sets = payload.sets ?? [];
  return sets
    .filter((s): s is NonNullable<typeof s> & { id: string; name: string } =>
      Boolean(s.id && s.name)
    )
    .sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""))
    .map((s) => ({
      sourceSetId: s.id,
      name: s.name,
      series: "One Piece Card Game",
      printedTotal: s.cardCount?.official ?? null,
      total: s.cardCount?.total ?? null,
      releaseDate: s.releaseDate ? new Date(s.releaseDate) : null,
      symbolUrl: s.symbol ?? null,
      logoUrl: s.logo ?? null,
    }));
}

async function listOnePieceCardsInSet(
  sourceSetId: string
): Promise<SyncCardInput[]> {
  const res = await fetch(
    `https://api.tcgdex.net/v2/en/sets/${encodeURIComponent(sourceSetId)}`
  );
  if (!res.ok) {
    throw new Error(`tcgdex /sets/${sourceSetId} HTTP ${res.status}`);
  }
  const payload = (await res.json()) as TcgdexSetDetail;
  const cards = payload.cards ?? [];

  return cards
    .filter((c): c is NonNullable<typeof c> & { id: string; name: string } =>
      Boolean(c.id && c.name)
    )
    .map((c) => ({
      externalId: c.id,
      name: c.name,
      number: c.localId ?? c.id,
      rarity: c.rarity ?? null,
      types: [],
      // TCGdex image URLs need a suffix for size + format. Their docs
      // recommend `/high.png` or `/low.png`. Use both slots so callers
      // can pick.
      imageUrl: c.image ? `${c.image}/low.webp` : null,
      imageUrlHi: c.image ? `${c.image}/high.webp` : null,
      marketPrice: null,
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
