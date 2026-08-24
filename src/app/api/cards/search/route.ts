/**
 * GET /api/cards/search
 *
 * Searches Pokémon or One Piece cards across multiple external APIs,
 * using a redundant fallback chain + Redis caching.
 *
 * Query params:
 *   - `game`   Required. `"pokemon"` or `"onepiece"`.
 *   - `query`  Required. Free-text search term (e.g. `"charizard"`).
 *
 * Response (200):
 * ```json
 * { "cards": [ { "id": "...", "name": "...", "source": "tcgdex" } ], "source": "tcgdex" }
 * ```
 *
 * Response (404): all fallback sources exhausted or returned nothing.
 * Response (400): missing/invalid `game` or `query`.
 *
 * -------------------------------------------------------------------
 * AUTH
 * -------------------------------------------------------------------
 * The `requireAuth` guard is wired in but currently *commented out* so the
 * endpoint is publicly testable during Week 1. Flip `ENFORCE_AUTH` to `true`
 * (or remove the flag) to lock it down behind a Better Auth session.
 *
 * -------------------------------------------------------------------
 * TEST WITH cURL
 * -------------------------------------------------------------------
 *   curl "http://localhost:3000/api/cards/search?game=pokemon&query=charizard"
 *   curl "http://localhost:3000/api/cards/search?game=onepiece&query=luffy"
 * -------------------------------------------------------------------
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/utils/auth-guard";
import { searchCards } from "@/lib/services/card.service";

/**
 * Set to `true` to require a valid session before searching.
 * Left `false` for Week 1 public testing of the fallback chain.
 */
const ENFORCE_AUTH = false;

/** Strict validation of the query string. */
const SearchQuerySchema = z.object({
  game: z.enum(["pokemon", "onepiece"]),
  query: z
    .string()
    .trim()
    .min(1, "query must not be empty")
    .max(100, "query is too long"),
});

export async function GET(request: Request): Promise<NextResponse> {
  // --------------------------------------------------------------
  // 0. Optional auth gate (structure ready for Week 2 lock-down)
  // --------------------------------------------------------------
  if (ENFORCE_AUTH) {
    const guard = await requireAuth(request);
    if (guard.unauthorized) return guard.unauthorized;
  }

  // --------------------------------------------------------------
  // 1. Parse + validate query params
  // --------------------------------------------------------------
  const { searchParams } = new URL(request.url);
  const parsed = SearchQuerySchema.safeParse({
    game: searchParams.get("game") ?? undefined,
    query: searchParams.get("query") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Bad Request",
        message: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
      { status: 400 }
    );
  }

  const { game, query } = parsed.data;

  // --------------------------------------------------------------
  // 2. Run the fallback chain (cache-aware)
  // --------------------------------------------------------------
  try {
    const result = await searchCards(game, query);

    // Every API succeeded-but-empty is still a 404 from the client's POV:
    // there is simply no matching card anywhere.
    if (result.cards.length === 0) {
      return NextResponse.json(
        {
          error: "Not Found",
          message: `No cards found for "${query}" across any source.`,
          source: result.source,
        },
        { status: 404 }
      );
    }

    return NextResponse.json(result, {
      status: 200,
      headers: {
        // Allow short browser/CDN caching of successful reads; the Redis
        // layer is the source of truth for freshness.
        "Cache-Control": "public, max-age=60, stale-while-revalidate=600",
      },
    });
  } catch (err) {
    // All fallback tasks failed — surface a clear 404/502 hybrid.
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[cards/search] All fallbacks failed for game="${game}" query="${query}":`,
      message
    );

    return NextResponse.json(
      {
        error: "Not Found",
        message:
          "All card data sources are unavailable. Please try again later.",
        detail: message,
      },
      { status: 404 }
    );
  }
}
