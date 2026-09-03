/**
 * GET /api/ebay/search
 *
 * Query params:
 *   - `name`   (required) — card name
 *   - `set`    (optional) — set / expansion name
 *   - `number` (optional) — printed card number or Bandai code
 *   - `game`   (required) — "pokemon" | "onepiece" (drives category filter)
 *
 * Wraps the eBay Browse API service in a Redis-cached HTTP handler so
 * the UI never hammers eBay directly.
 *
 * Cache key composes all four params (lowercased/trimmed) so different
 * cards with the same name (e.g. reprints across sets) don't share a
 * cache entry.
 *
 * Backwards-compatible: if a caller still passes only `q=<term>`, we
 * treat it as `{ name: q, game: "pokemon" }` and log a deprecation
 * warning, so existing callers keep working while we migrate them.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  searchEbayListings,
  type EbayGame,
  type EbaySearchParams,
  type NormalizedEbayListing,
} from "@/lib/services/ebay.service";
import { redis, RedisKeys } from "@/lib/redis";

interface EbaySearchOk {
  listings: NormalizedEbayListing[];
  source: "cache" | "live";
}

interface EbaySearchFallback {
  error: string;
  fallback: true;
  listings: [];
}

/** Cache TTL — 24h per client spec. */
const CACHE_TTL_SECONDS = 86_400;

function isGame(value: string | null): value is EbayGame {
  return value === "pokemon" || value === "onepiece";
}

function badRequest(message: string): NextResponse {
  return NextResponse.json(
    { error: message, fallback: true, listings: [] },
    { status: 400 }
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const sp = request.nextUrl.searchParams;

  const nameParam = (sp.get("name") ?? sp.get("q") ?? "").trim();
  const setParam = (sp.get("set") ?? "").trim();
  const numberParam = (sp.get("number") ?? "").trim();
  const gameParam = sp.get("game");

  if (!nameParam) {
    return badRequest("Missing required `name` query parameter");
  }

  // Backwards compatibility for the old `?q=` callers — default game
  // to pokemon since that's the historical assumption. Callers should
  // migrate to explicit `name` + `game`.
  let game: EbayGame;
  if (isGame(gameParam)) {
    game = gameParam;
  } else if (gameParam == null && sp.get("q")) {
    console.warn(
      "[api/ebay/search] Legacy `?q=` call without `game` — defaulting to pokemon."
    );
    game = "pokemon";
  } else {
    return badRequest(
      "Missing or invalid `game` query parameter (must be 'pokemon' or 'onepiece')"
    );
  }

  const params: EbaySearchParams = {
    name: nameParam,
    ...(setParam ? { set: setParam } : {}),
    ...(numberParam ? { number: numberParam } : {}),
    game,
  };

  // Compose a stable cache key from all four inputs, lower-cased so
  // trivial casing differences don't fragment the cache. Using `|` as
  // a separator because it's not a valid character in card names, sets,
  // or codes we've seen.
  const cacheKeyRaw = [
    params.name,
    params.set ?? "",
    params.number ?? "",
    params.game,
  ]
    .map((v) => v.toLowerCase().trim())
    .join("|");
  const cacheKey = RedisKeys.ebaySearch(cacheKeyRaw);

  // -------------------------------------------------------------
  // Cache lookup — best-effort; a Redis miss/error falls through
  // to a live eBay call rather than 500-ing on the user.
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
  // Live eBay call + graceful degradation
  // -------------------------------------------------------------
  try {
    const listings = await searchEbayListings(params);

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
    console.error(
      `[api/ebay/search] eBay call failed for name="${nameParam}" game="${game}":`,
      message
    );

    // Graceful fallback — HTTP 200 with a `fallback: true` marker so the
    // UI renders "eBay unavailable" instead of a raw 5xx toast.
    const body: EbaySearchFallback = {
      error: "eBay unavailable",
      fallback: true,
      listings: [],
    };
    return NextResponse.json(body, { status: 200 });
  }
}
