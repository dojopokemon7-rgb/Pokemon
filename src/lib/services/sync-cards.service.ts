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

    const setSummary = await syncOneSet(game, set, deadline);
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
  deadline: number
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
        ? await listPokemonCardsInSet(set.sourceSetId)
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
      await Promise.all(chunk.map((card) => upsertCard(card, dbSet.id)));
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
async function upsertCard(card: SyncCardInput, setId: string): Promise<void> {
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
      setId,
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

const APITCG_BASE = "https://api.apitcg.com";

interface ApitcgSet {
  _id?: string;
  name?: string;
  code?: string;
  release_date?: string;
}
interface ApitcgSetsResponse {
  success?: boolean;
  data?: ApitcgSet[];
}
interface ApitcgCard {
  code?: string;
  name?: string;
  images?: Array<{ small?: string; medium?: string; large?: string }>;
  markets?: { tcgplayer?: { prices?: { market?: number } } };
  attributes?: {
    Rarity?: string;
    Number?: string;
    Color?: string;
    CardType?: string;
    Subtypes?: string;
    Attribute?: string;
  };
}
interface ApitcgCardsResponse {
  success?: boolean;
  data?: ApitcgCard[];
  total?: number;
}

function apitcgHeaders(): HeadersInit {
  const key = process.env.APITCG_API_KEY;
  if (!key) {
    throw new Error("APITCG_API_KEY is not set — cannot sync One Piece");
  }
  return { "x-api-key": key };
}

async function listOnePieceSets(): Promise<SyncSetInput[]> {
  const res = await fetch(`${APITCG_BASE}/api/one-piece/sets`, {
    headers: apitcgHeaders(),
  });
  if (!res.ok) {
    throw new Error(`apitcg /one-piece/sets HTTP ${res.status}`);
  }
  const payload = (await res.json()) as ApitcgSetsResponse;
  const sets = payload.data ?? [];
  return sets
    .filter(
      (s): s is ApitcgSet & { _id: string; name: string } =>
        Boolean(s._id && s.name)
    )
    // Newest first so recent sets sync ahead of old ones.
    .sort((a, b) =>
      (b.release_date ?? "").localeCompare(a.release_date ?? "")
    )
    .map((s) => ({
      sourceSetId: s._id,
      name: s.name,
      series: "One Piece Card Game",
      printedTotal: null,
      total: null,
      releaseDate: s.release_date ? new Date(s.release_date) : null,
      symbolUrl: null,
      logoUrl: null,
    }));
}

async function listOnePieceCardsInSet(
  sourceSetId: string
): Promise<SyncCardInput[]> {
  // limit=500 covers every real-world OP set (OP01 had 163; largest
  // observed is under 300). If a set grows beyond that we'll switch
  // to `page=` pagination — for now a single request keeps the code
  // dead simple.
  const url =
    `${APITCG_BASE}/api/products?tcg=one-piece` +
    `&set=${encodeURIComponent(sourceSetId)}&limit=500`;
  const res = await fetch(url, { headers: apitcgHeaders() });
  if (!res.ok) {
    throw new Error(`apitcg /products?set=${sourceSetId} HTTP ${res.status}`);
  }
  const payload = (await res.json()) as ApitcgCardsResponse;
  const cards = payload.data ?? [];

  return cards
    .filter((c): c is ApitcgCard & { code: string; name: string } =>
      Boolean(c.code && c.name)
    )
    .map((c) => {
      const attrs = c.attributes ?? {};
      // Card type / colour become "types" so the UI filters keep working
      // — same convention as our existing user search adapter.
      const types = [attrs.Color, attrs.CardType, attrs.Attribute]
        .filter((v): v is string => typeof v === "string" && v.length > 0);
      const image =
        c.images?.[0]?.large ??
        c.images?.[0]?.medium ??
        c.images?.[0]?.small ??
        null;
      return {
        externalId: c.code,                   // e.g. "OP01-064"
        name: c.name,
        number: attrs.Number ?? c.code,
        rarity: attrs.Rarity ?? null,
        types,
        imageUrl: c.images?.[0]?.small ?? image,
        imageUrlHi: c.images?.[0]?.large ?? image,
        marketPrice: c.markets?.tcgplayer?.prices?.market ?? null,
      };
    });
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
