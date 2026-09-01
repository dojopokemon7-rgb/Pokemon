/**
 * GET /api/ebay/search?q=<term>
 *
 * Wraps the eBay Browse API service in a Redis-cached HTTP handler so
 * the UI never hammers eBay directly. Flow:
 *
 *   1. Validate `?q=` and lowercase it for a stable cache key.
 *   2. Redis lookup (`ebay:search:<q>`) — hit → return cached JSON.
 *   3. Miss → call `searchEbayListings(q)` and cache for 24 hours.
 *   4. Any thrown error (missing creds, HTTP 429, 5xx, JSON errors)
 *      becomes a graceful fallback response so the UI can render an
 *      "eBay unavailable" state instead of a 5xx page.
 *
 * The `fallback: true` flag makes it trivial for the client to
 * distinguish "no results" (empty listings) from "we couldn't reach
 * eBay right now" (fallback envelope).
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  searchEbayListings,
  type NormalizedEbayListing,
} from "@/lib/services/ebay.service";
import { redis, RedisKeys } from "@/lib/redis";

/** Successful response shape returned to the client. */
interface EbaySearchOk {
  listings: NormalizedEbayListing[];
  source: "cache" | "live";
}

/** Fallback shape — surfaced when eBay is unreachable or errored. */
interface EbaySearchFallback {
  error: string;
  fallback: true;
  listings: [];
}

/** Cache TTL — 24h per client spec. */
const CACHE_TTL_SECONDS = 86_400;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const q = (request.nextUrl.searchParams.get("q") ?? "").trim();

  if (!q) {
    return NextResponse.json(
      { error: "Missing required `q` query parameter", fallback: true, listings: [] },
      { status: 400 }
    );
  }

  const cacheKey = RedisKeys.ebaySearch(q);

  // -------------------------------------------------------------
  // 1. Cache lookup (best-effort; a Redis miss/error falls through
  //    to a live eBay call rather than 500-ing on the user).
  // -------------------------------------------------------------
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as NormalizedEbayListing[];
      const body: EbaySearchOk = { listings: parsed, source: "cache" };
      return NextResponse.json(body, { status: 200 });
    }
  } catch (err) {
    console.warn(
      "[api/ebay/search] Cache read failed, proceeding to live call:",
      err instanceof Error ? err.message : err
    );
  }

  // -------------------------------------------------------------
  // 2. Live eBay call + graceful degradation
  // -------------------------------------------------------------
  try {
    const listings = await searchEbayListings(q);

    // Cache-write is best-effort; a Redis write failure still returns
    // the fresh listings to the caller.
    try {
      await redis.set(
        cacheKey,
        JSON.stringify(listings),
        "EX",
        CACHE_TTL_SECONDS
      );
    } catch (err) {
      console.warn(
        "[api/ebay/search] Cache write failed (non-fatal):",
        err instanceof Error ? err.message : err
      );
    }

    const body: EbaySearchOk = { listings, source: "live" };
    return NextResponse.json(body, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[api/ebay/search] eBay call failed for q="${q}":`, message);

    // Graceful fallback — HTTP 200 with a `fallback: true` marker so the
    // UI renders "eBay unavailable, showing your own data instead"
    // rather than a raw 5xx toast. If you'd prefer non-2xx propagation
    // for observability, change the status here to 502 without changing
    // the body shape.
    const body: EbaySearchFallback = {
      error: "eBay unavailable",
      fallback: true,
      listings: [],
    };
    return NextResponse.json(body, { status: 200 });
  }
}
