/**
 * Backfill Card.marketPrice for the WHOLE catalog (Pokémon + One Piece).
 *
 * Many cards show "—" in the UI because marketPrice is null/0 in the DB.
 * This one-shot script asks the real source APIs for a current market price
 * and writes it to Card.marketPrice (+ lastPricedAt), and also seeds ONE
 * PricingHistory anchor point per newly-priced card so the detail chart has
 * real data to draw instead of its mock fallback.
 *
 * Usage (env-file REQUIRED — the API keys live in .env and a bare `tsx` run
 * does NOT load them, so every request would be rate-limited/401):
 *   npx tsx --env-file=.env scripts/backfill-prices.ts
 *
 * Sources (no fabrication — a card with no upstream price stays null → "—"):
 *   - Pokémon  : Pokémon TCG API, bulk per set
 *                (tcgplayer.market → cardmarket averageSellPrice/trend/avg).
 *   - One Piece: apitcg.com /api/products, bulk per set
 *                (markets.tcgplayer.prices.market).
 *
 * Both fetch per-set (one request per set, not per card) and retry on 5xx.
 * Safe to re-run: only ever looks at cards whose marketPrice is null or 0.
 *
 * Exported `backfillPrices()` is reused by the seed so future imports always
 * end with prices filled in.
 */

import { prisma } from "@/lib/db";
import { pickPokemonMarketPrice } from "@/lib/utils/card-price";

const POKEMON_BASE = "https://api.pokemontcg.io/v2";
const APITCG_BASE = "https://api.apitcg.com";
const MAX_ATTEMPTS = 5;
const THROTTLE_MS = 300; // between set-fetch batches — be a good API citizen
const FETCH_CONCURRENCY = 5; // set price-maps fetched in parallel per batch
const HISTORY_SOURCE = "backfill-anchor"; // marks the seeded anchor point

const REQUEST_TIMEOUT_MS = 15_000; // hard cap so a hung TCP connection can't stall the whole run
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch() with a hard timeout — aborts the request (not just the promise) so
 *  a stalled connection can never wedge the run. Throws on timeout/abort. */
async function fetchWithTimeout(url: string, headers?: HeadersInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** API id is "<setId>-<number>"; the setId is everything before the last dash. */
function setIdOf(externalId: string): string {
  const dash = externalId.lastIndexOf("-");
  return dash > 0 ? externalId.slice(0, dash) : externalId;
}

// ------------------------------------------------------------------
// Pokémon — bulk price map per set via pokemontcg.io
// ------------------------------------------------------------------
interface PokemonApiCard {
  id: string;
  tcgplayer?: { prices?: Record<string, { market?: number | null }> } | null;
  cardmarket?: {
    prices?: { averageSellPrice?: number; trendPrice?: number; avg7?: number; avg30?: number };
  } | null;
}

async function fetchPokemonSetPrices(setId: string): Promise<Map<string, number>> {
  const key = process.env.POKEMON_TCG_API_KEY;
  const url =
    `${POKEMON_BASE}/cards?q=set.id:${encodeURIComponent(setId)}` +
    `&select=id,tcgplayer,cardmarket&pageSize=250`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchWithTimeout(url, key ? { "X-Api-Key": key } : undefined);
      if (res.ok) {
        const json = (await res.json()) as { data?: PokemonApiCard[] };
        const out = new Map<string, number>();
        for (const c of json.data ?? []) {
          const price = pickPokemonMarketPrice({
            tcgplayer: c.tcgplayer ?? undefined,
            cardmarket: c.cardmarket ?? undefined,
          });
          if (price != null) out.set(c.id, price);
        }
        return out;
      }
    } catch {
      /* network/timeout — retry */
    }
    if (attempt < MAX_ATTEMPTS) await sleep(attempt * 800);
  }
  return new Map();
}

// ------------------------------------------------------------------
// One Piece — bulk price map per set via apitcg.com
// ------------------------------------------------------------------
interface ApitcgCard {
  code?: string;
  markets?: { tcgplayer?: { prices?: { market?: number } } };
}

/** Maps our set externalId ("onepiece-<slug>") back to apitcg's set slug. */
function apitcgSlugOf(setExternalId: string): string {
  return setExternalId.replace(/^onepiece-/, "");
}

async function fetchOnePieceSetPrices(setSlug: string): Promise<Map<string, number>> {
  const key = process.env.APITCG_API_KEY;
  if (!key) return new Map();
  const url = `${APITCG_BASE}/api/products?tcg=one-piece&set=${encodeURIComponent(setSlug)}&limit=500`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { "x-api-key": key });
      if (res.ok) {
        const json = (await res.json()) as { data?: ApitcgCard[] };
        const out = new Map<string, number>();
        for (const c of json.data ?? []) {
          const m = c.markets?.tcgplayer?.prices?.market;
          if (c.code && typeof m === "number" && Number.isFinite(m) && m > 0) out.set(c.code, m);
        }
        return out;
      }
    } catch {
      /* retry */
    }
    if (attempt < MAX_ATTEMPTS) await sleep(attempt * 800);
  }
  return new Map();
}

/** DB write concurrency per set — Supabase pooler handles this comfortably
 *  and it turns serial ~80ms round-trips into single-digit seconds per set. */
const WRITE_CONCURRENCY = 10;

/** Writes the price and seeds one history anchor (idempotent per card+source). */
async function applyPrice(cardId: string, price: number, day: Date): Promise<void> {
  // One anchor point so the chart draws a real (flat) series instead of its
  // mock fallback. Idempotent: replace any prior anchor for this card, then
  // write the fresh price + anchor.
  await prisma.pricingHistory.deleteMany({ where: { cardId, source: HISTORY_SOURCE } });
  await Promise.all([
    prisma.card.update({
      where: { id: cardId },
      data: { marketPrice: price, lastPricedAt: new Date() },
    }),
    prisma.pricingHistory.create({
      data: { cardId, price, source: HISTORY_SOURCE, currency: "USD", recordedAt: day },
    }),
  ]);
}

/** Prices one group of cards against a fetched price map, writing in parallel
 *  chunks. Returns how many were priced. */
async function priceGroup(
  group: { id: string; externalId: string }[],
  prices: Map<string, number>,
  day: Date
): Promise<number> {
  const hits = group.filter((c) => prices.get(c.externalId) != null);
  for (let i = 0; i < hits.length; i += WRITE_CONCURRENCY) {
    const chunk = hits.slice(i, i + WRITE_CONCURRENCY);
    await Promise.all(chunk.map((c) => applyPrice(c.id, prices.get(c.externalId)!, day)));
  }
  return hits.length;
}

export interface BackfillPricesResult {
  pokemonUpdated: number;
  onePieceUpdated: number;
  stillMissing: number;
}

export async function backfillPrices(log = true): Promise<BackfillPricesResult> {
  const say = (m: string) => log && console.log(m);
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0); // UTC midnight so chart points align by day

  const cards = await prisma.card.findMany({
    where: { OR: [{ marketPrice: null }, { marketPrice: 0 }] },
    select: { id: true, externalId: true, set: { select: { externalId: true } } },
  });

  // Group null-priced cards by source set.
  const pokemonBySet = new Map<string, { id: string; externalId: string }[]>();
  const onePieceBySet = new Map<string, { id: string; externalId: string }[]>();
  const pushInto = (
    map: Map<string, { id: string; externalId: string }[]>,
    key: string,
    c: { id: string; externalId: string }
  ) => {
    let group = map.get(key);
    if (!group) map.set(key, (group = []));
    group.push(c);
  };
  for (const c of cards) {
    const setExt = c.set.externalId;
    if (setExt.startsWith("pokemon-")) pushInto(pokemonBySet, setIdOf(c.externalId), c);
    else if (setExt.startsWith("onepiece-")) pushInto(onePieceBySet, setExt, c);
  }

  say(
    `\n💰 Backfilling prices — ${cards.length} null/0-priced card(s): ` +
      `Pokémon ${[...pokemonBySet.values()].reduce((n, g) => n + g.length, 0)} across ${pokemonBySet.size} set(s), ` +
      `One Piece ${[...onePieceBySet.values()].reduce((n, g) => n + g.length, 0)} across ${onePieceBySet.size} set(s)…\n`
  );

  let pokemonUpdated = 0;
  let onePieceUpdated = 0;
  let stillMissing = 0;

  // Fetch several sets' price maps concurrently (the network round-trip, not
  // the DB write, is the bottleneck across 100+ sets), then write serially so
  // logs stay ordered and the pooler isn't hammered by every set at once.
  const runGame = async (
    label: string,
    entries: [string, { id: string; externalId: string }[]][],
    slugOf: (key: string) => string,
    fetchFn: (slug: string) => Promise<Map<string, number>>,
    onHit: (n: number) => void
  ) => {
    for (let i = 0; i < entries.length; i += FETCH_CONCURRENCY) {
      const batch = entries.slice(i, i + FETCH_CONCURRENCY);
      const maps = await Promise.all(batch.map(([k]) => fetchFn(slugOf(k))));
      for (let j = 0; j < batch.length; j++) {
        const [key, group] = batch[j];
        const hit = await priceGroup(group, maps[j], day);
        onHit(hit);
        stillMissing += group.length - hit;
        say(`  [${label}] ${slugOf(key).padEnd(30)} priced ${hit}/${group.length}`);
      }
      await sleep(THROTTLE_MS);
    }
  };

  await runGame(
    "pokemon ",
    [...pokemonBySet.entries()],
    (k) => k,
    fetchPokemonSetPrices,
    (n) => { pokemonUpdated += n; }
  );
  await runGame(
    "onepiece",
    [...onePieceBySet.entries()],
    apitcgSlugOf,
    fetchOnePieceSetPrices,
    (n) => { onePieceUpdated += n; }
  );

  say(
    `\n🎉 Done — ${pokemonUpdated} Pokémon + ${onePieceUpdated} One Piece priced ` +
      `(${pokemonUpdated + onePieceUpdated} total), ${stillMissing} left as "—" (no upstream price).\n`
  );

  return { pokemonUpdated, onePieceUpdated, stillMissing };
}

// Run standalone unless imported (seed imports backfillPrices).
if (process.argv[1] && process.argv[1].endsWith("backfill-prices.ts")) {
  backfillPrices()
    .catch((err) => {
      console.error("backfill-prices failed:", err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
