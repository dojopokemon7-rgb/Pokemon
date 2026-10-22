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
import { z } from "zod";
import {
  searchEbayListings,
  type EbayGame,
  type EbaySearchParams,
  type NormalizedEbayListing,
} from "@/lib/services/ebay.service";
import { redis, RedisKeys } from "@/lib/redis";
import { enforceRateLimit, searchTier, clientIp } from "@/lib/utils/rate-limit";

// Re-validates the cached listing array on READ (audit 12 F3, AGENTS.md RULE 4).
// Mirrors NormalizedEbayListing in ebay.service.ts exactly; NOT strict so an
// additive future field doesn't force a needless cache miss (a changed/removed
// field still fails and triggers the intended miss). A parse failure is treated
// as a MISS — fall through to the live eBay call, which re-caches the correct
// shape — rather than serving an unvalidated blob verbatim.
const CachedEbayListingsSchema = z.array(
  z.object({
    itemId: z.string(),
    title: z.string(),
    price: z.number(),
    currency: z.string().nullable(),
    imageUrl: z.string().nullable(),
    itemWebUrl: z.string(),
  })
);

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
  // F-2: per-IP rate limit FIRST — public/anonymous compare-on-eBay route (no
  // auth wall). Fail-open on Redis outage (RULE 1). Keyed by IP only; shares the
  // `search` bucket with cards/search's IP fallback.
  const limited = await enforceRateLimit(request, searchTier(), { kind: "ip", id: clientIp(request) });
  if (limited) return limited;

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
      // Re-validate the cached blob (RULE 4). A parse failure — malformed JSON
      // (caught below) OR a stale/wrong shape — is a MISS: fall through to the
      // live call, which re-caches the correct shape. Never serve a blob verbatim.
      const parsed = CachedEbayListingsSchema.safeParse(JSON.parse(cached));
      if (parsed.success) {
        const body: EbaySearchOk = { listings: parsed.data, source: "cache" };
        return NextResponse.json(body, { status: 200 });
      }
      console.warn(
        "[api/ebay/search] Cached payload failed validation, proceeding to live call."
      );
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
