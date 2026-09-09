/**
 * GET /api/cards/search
 *
 * Searches Pokémon or One Piece cards. As of the Daily Sync Engine
 * rollout this reads EXCLUSIVELY from the local Supabase catalog —
 * external APIs are only hit by /api/cron/sync-cards. This makes user
 * searches instant and eliminates the API-ban risk that came with
 * live-fetching on every keystroke.
 *
 * Query params:
 *   - `game`   Required. `"pokemon"` or `"onepiece"`.
 *   - `query`  Required. Free-text search term.
 *
 * Response (200):
 * ```json
 * {
 *   "cards": [ { "id": "base1-4", "name": "Charizard", "setImage": "Base",
 *                "rarity": "Rare Holo", "hp": null, "types": ["Fire"],
 *                "imageUrl": "https://...", "marketPrice": 246.00 } ],
 *   "source": "local-db"
 * }
 * ```
 *
 * Response (404): local catalog has no matches for this query (yet —
 *   the sync may not have reached the relevant set).
 * Response (400): missing/invalid `game` or `query`.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/utils/auth-guard";
import { CardSortEnum, orderByForCardSort } from "@/lib/utils/card-sort";
import type { NormalizedCard } from "@/lib/validators/card.validator";

/** Flip to `true` to gate search behind a valid Better Auth session. */
const ENFORCE_AUTH = false;

/** Cap results at a sensible page — the UI grid renders ~60 tiles well. */
const RESULT_LIMIT = 60;

const SearchQuerySchema = z.object({
  game: z.enum(["pokemon", "onepiece"]),
  query: z
    .string()
    .trim()
    .min(1, "query must not be empty")
    .max(100, "query is too long"),
  sort: CardSortEnum.default("market_desc"),
});

export async function GET(request: Request): Promise<NextResponse> {
  if (ENFORCE_AUTH) {
    const guard = await requireAuth(request);
    if (guard.unauthorized) return guard.unauthorized;
  }

  const { searchParams } = new URL(request.url);
  const parsed = SearchQuerySchema.safeParse({
    game: searchParams.get("game") ?? undefined,
    query: searchParams.get("query") ?? undefined,
    sort: searchParams.get("sort") ?? undefined,
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

  const { game, query, sort } = parsed.data;

  // ---------------------------------------------------------------
  // Local catalog query
  // ---------------------------------------------------------------
  // Game filter piggybacks on the `pokemon-*` / `onepiece-*` prefix
  // convention on `CardSet.externalId` (same convention used by the
  // trending + admin routes). Ordering favours priced cards first so
  // notable/valuable cards surface above unpriced filler.
  const rows = await prisma.card.findMany({
    where: {
      name: { contains: query, mode: "insensitive" },
      set: { externalId: { startsWith: `${game}-` } },
    },
    take: RESULT_LIMIT,
    orderBy: orderByForCardSort(sort),
    select: {
      externalId: true,
      name: true,
      rarity: true,
      types: true,
      imageUrl: true,
      imageUrlHi: true,
      marketPrice: true,
      set: { select: { name: true } },
    },
  });

  if (rows.length === 0) {
    return NextResponse.json(
      {
        error: "Not Found",
        message: `No local matches for "${query}". The daily sync may not have reached this set yet.`,
        source: "local-db",
      },
      { status: 404 }
    );
  }

  // Match the pre-existing NormalizedCard envelope so no client changes
  // are required. `hp` is null: the schema doesn't store it — that
  // column would need to be added if the UI ever needs HP again.
  const cards: NormalizedCard[] = rows.map((r) => ({
    id: r.externalId,
    name: r.name,
    setImage: r.set?.name ?? "",
    rarity: r.rarity ?? "Unknown",
    hp: null,
    types: r.types ?? [],
    imageUrl: r.imageUrl ?? r.imageUrlHi ?? "",
    marketPrice: r.marketPrice,
  }));

  return NextResponse.json(
    { cards, source: "local-db" },
    {
      status: 200,
      headers: {
        // Short public cache — the local DB is already fast, this just
        // buffers a repeated keystroke against the same query.
        "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
      },
    }
  );
}
