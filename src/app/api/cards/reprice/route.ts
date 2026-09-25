import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { redis, RedisKeys } from "@/lib/redis";
import { pickPokemonMarketPrice, type PokemonPricePayload } from "@/lib/utils/card-price";

/**
 * POST /api/cards/reprice — background price backfill for cards the batch
 * sync hasn't priced yet (brand-new sets, or sets synced while the upstream
 * price API was down).
 *
 * This is deliberately OFF the search hot path: the search/trending routes
 * always read the local DB and never block on an external call, so the grid
 * stays instant. The client fires this AFTER render for the handful of tiles
 * showing no price, then refetches — so prices fill in live without slowing
 * the initial load.
 *
 *   Request:  { externalIds: string[] }  (Pokémon card ids, e.g. "me4-122")
 *   Response: { prices: { [externalId]: number } }  (only ids we could price)
 *
 * For each id: Redis cache → live pokemontcg.io fetch → extract market price →
 * cache (6h) + backfill Card.marketPrice. Any failure is skipped silently
 * (the tile just keeps showing "—"); the endpoint never 500s the UI.
 */

// Cap per request so a page can't fan out into hundreds of upstream calls.
const MAX_IDS = 20;
const PRICE_TTL_SECONDS = 6 * 60 * 60; // 6h — matches RedisKeys.cardPrice contract

/** Fetches one Pokémon card's live price by id. Returns null on any failure. */
async function fetchLivePrice(externalId: string): Promise<number | null> {
  try {
    const key = process.env.POKEMON_TCG_API_KEY;
    const res = await fetch(
      `https://api.pokemontcg.io/v2/cards/${encodeURIComponent(externalId)}`,
      { headers: key ? { "X-Api-Key": key } : {}, signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return null;
    const card = ((await res.json()) as { data?: PokemonPricePayload })?.data;
    if (!card) return null;
    return pickPokemonMarketPrice(card);
  } catch {
    return null; // upstream down / timeout / bad shape — skip, tile stays "—"
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ prices: {} });
  }

  const ids = Array.isArray((body as { externalIds?: unknown })?.externalIds)
    ? ((body as { externalIds: unknown[] }).externalIds
        .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        .slice(0, MAX_IDS))
    : [];
  if (ids.length === 0) return NextResponse.json({ prices: {} });

  const prices: Record<string, number> = {};

  await Promise.all(
    ids.map(async (externalId) => {
      // 1. Redis cache.
      try {
        const cached = await redis.get(RedisKeys.cardPrice(externalId));
        if (cached != null) {
          const n = Number.parseFloat(cached);
          if (Number.isFinite(n)) { prices[externalId] = n; return; }
        }
      } catch {
        /* cache miss/outage → fall through to live */
      }

      // 2. Live fetch.
      const price = await fetchLivePrice(externalId);
      if (price == null) return;
      prices[externalId] = price;

      // 3. Cache + DB backfill (both best-effort; never block the response).
      try {
        await redis.set(RedisKeys.cardPrice(externalId), String(price), "EX", PRICE_TTL_SECONDS);
      } catch { /* non-fatal */ }
      try {
        await prisma.card.update({
          where: { externalId },
          data: { marketPrice: price, lastPricedAt: new Date() },
        });
      } catch { /* card may not exist locally; non-fatal */ }
    })
  );

  return NextResponse.json({ prices });
}
