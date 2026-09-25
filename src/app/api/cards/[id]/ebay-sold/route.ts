/**
 * GET /api/cards/[id]/ebay-sold — real eBay listings for a card, powering
 * the "Sellers on the Floor" section on the card detail page.
 *
 * `[id]` is the external card id (used only for the cache key / game hint).
 * Card identity is passed as query params so we don't need a get-by-id
 * lookup:
 *   ?name=Charizard&set=Obsidian%20Flames&grade=PSA%2010&game=pokemon
 *
 * NOTE — active listings, not sold history: eBay's Browse API has no
 * sold/completed filter (sold data lives behind the restricted Marketplace
 * Insights API). So this returns REAL, CURRENT listings for the card —
 * genuine eBay data, never mocked. Cached 1h to respect rate limits.
 *
 * Response (200): { listings: EbaySellerListing[], source: "cache"|"live" }
 * On any failure: { listings: [], error } with 200 so the UI shows
 * "No recent sales found" rather than crashing.
 */

import { NextResponse, type NextRequest } from "next/server";
import { searchEbaySellerListings, type EbayGame } from "@/lib/services/ebay.service";
import { redis, RedisKeys } from "@/lib/redis";

const CACHE_TTL_SECONDS = 3600; // 1 hour

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const sp = request.nextUrl.searchParams;
  const name = (sp.get("name") ?? "").trim();
  const set = (sp.get("set") ?? "").trim();
  const number = (sp.get("number") ?? "").trim();
  const gameParam = sp.get("game");
  const game: EbayGame = gameParam === "onepiece" ? "onepiece" : "pokemon";

  if (!name) {
    return NextResponse.json({ listings: [], error: "Missing card name" }, { status: 200 });
  }

  // The card NUMBER is the strongest search token — the "125/197" print for
  // Pokémon, the Bandai code (OP01-001) for One Piece (which is exactly `id`).
  // Prefer the passed `number`; fall back to `id` for One Piece where the id
  // IS the code. The service decides how to weight it per game, and (crucially
  // for One Piece) drops the set/grade phrases that used to zero out results.
  const cardNumber = number || (game === "onepiece" ? id : "");
  const searchParams = { name, game, ...(set ? { set } : {}), ...(cardNumber ? { number: cardNumber } : {}) };
  const cacheKey = RedisKeys.ebaySold([id, name, set, cardNumber, game].join("|"));

  // Best-effort cache read; a Redis miss/outage falls through to live.
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return NextResponse.json({ listings: JSON.parse(cached), source: "cache" }, { status: 200 });
    }
  } catch (err) {
    console.warn("[cards/ebay-sold] cache read failed:", err instanceof Error ? err.message : err);
  }

  try {
    const listings = await searchEbaySellerListings(searchParams, 4);
    try {
      await redis.set(cacheKey, JSON.stringify(listings), "EX", CACHE_TTL_SECONDS);
    } catch (err) {
      console.warn("[cards/ebay-sold] cache write failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    return NextResponse.json({ listings, source: "live" }, { status: 200 });
  } catch (err) {
    // eBay down / rate-limited / bad creds → graceful empty, never crash.
    console.error("[cards/ebay-sold] eBay call failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ listings: [], error: "eBay unavailable" }, { status: 200 });
  }
}
