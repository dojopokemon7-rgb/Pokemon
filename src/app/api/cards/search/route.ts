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
 *   - `game`     Required. `"pokemon"` or `"onepiece"`.
 *   - `query`    Required. Free-text search term.
 *   - `sort`     Optional. Sort key (see CardSortEnum).
 *   - `set`      Optional (F-06). Filter to one set by name.
 *   - `rarity`   Optional (F-06). Filter by rarity (contains match).
 *   - `graded`   Optional (F-06). `"graded"` | `"ungraded"` (rarity-based).
 *   - `minPrice` Optional (F-06). Min marketPrice (USD).
 *   - `maxPrice` Optional (F-06). Max marketPrice (USD).
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
import { onePieceImageChain } from "@/lib/utils/card-image";
import type { NormalizedCard } from "@/lib/validators/card.validator";

/** Flip to `true` to gate search behind a valid Better Auth session. */
const ENFORCE_AUTH = false;

/** Cap results at a sensible page — the UI grid renders ~60 tiles well. */
const RESULT_LIMIT = 60;

/** Grading companies — a card is "graded" when its rarity names one of
 *  these (there's no dedicated grade column yet; graded-ness rides on
 *  `rarity`, e.g. "PSA 10"). See prisma/seed-test.ts. */
const GRADERS = ["PSA", "BGS", "CGC", "SGC", "Beckett"] as const;

const SearchQuerySchema = z.object({
  game: z.enum(["pokemon", "onepiece"]),
  query: z
    .string()
    .trim()
    .min(1, "query must not be empty")
    .max(100, "query is too long"),
  sort: CardSortEnum.default("market_desc"),
  // F-06: optional set filter. Matches on the joined CardSet.name (that's
  // the label the UI shows on each tile and in the filter dropdown).
  set: z.string().trim().min(1).max(100).optional(),
  // F-06: optional rarity filter — matches on Card.rarity (case-insensitive).
  rarity: z.string().trim().min(1).max(50).optional(),
  // F-06: graded/ungraded filter. "graded" → rarity names a grader;
  // "ungraded" → it doesn't; omitted → both.
  graded: z.enum(["graded", "ungraded"]).optional(),
  // F-06: price range on Card.marketPrice (USD). Coerced from query strings;
  // non-numeric/negative values are rejected.
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
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
    set: searchParams.get("set") ?? undefined,
    rarity: searchParams.get("rarity") ?? undefined,
    graded: searchParams.get("graded") ?? undefined,
    minPrice: searchParams.get("minPrice") ?? undefined,
    maxPrice: searchParams.get("maxPrice") ?? undefined,
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

  const { game, query, sort, set, rarity, graded, minPrice, maxPrice } = parsed.data;

  // ---------------------------------------------------------------
  // Local catalog query
  // ---------------------------------------------------------------
  // Game filter piggybacks on the `pokemon-*` / `onepiece-*` prefix
  // convention on `CardSet.externalId` (same convention used by the
  // trending + admin routes). Ordering favours priced cards first so
  // notable/valuable cards surface above unpriced filler.

  // F-06 graded/ungraded: graded-ness lives in `rarity` (e.g. "PSA 10").
  // A card is graded when its rarity starts with a grader name; ungraded
  // is the negation. Built as OR-of-startsWith across the known graders.
  const gradedMatch = GRADERS.map((g) => ({
    rarity: { startsWith: g, mode: "insensitive" as const },
  }));

  // F-06 price range on marketPrice. Compose gte/lte only for the bounds
  // that were provided.
  const priceFilter =
    minPrice != null || maxPrice != null
      ? {
          marketPrice: {
            ...(minPrice != null ? { gte: minPrice } : {}),
            ...(maxPrice != null ? { lte: maxPrice } : {}),
          },
        }
      : {};

  // Multi-field query match: name / card number / set name / set code
  // (the externalId encodes the code, e.g. "pokemon-sv3") / keyword tags.
  // Only applied when there's a query; an empty query lists the game's
  // catalog (unchanged). Wrapped in an AND so it composes with the graded
  // OR + game/price filters below without the two ORs colliding.
  const queryOr = query
    ? [
        { name: { contains: query, mode: "insensitive" as const } },
        { number: { contains: query, mode: "insensitive" as const } },
        { tags: { has: query.toLowerCase() } },
        { set: { name: { contains: query, mode: "insensitive" as const } } },
        { set: { externalId: { contains: query.toLowerCase() } } },
      ]
    : undefined;

  const rows = await prisma.card.findMany({
    where: {
      set: {
        externalId: { startsWith: `${game}-` },
        // F-06: narrow to a single set (by name) when the filter is active.
        ...(set ? { name: { equals: set, mode: "insensitive" } } : {}),
      },
      // F-06: rarity filter (case-insensitive exact-ish contains match).
      ...(rarity ? { rarity: { contains: rarity, mode: "insensitive" } } : {}),
      // F-06: graded → rarity names a grader; ungraded → it doesn't.
      ...(graded === "graded" ? { OR: gradedMatch } : {}),
      ...(graded === "ungraded" ? { NOT: { OR: gradedMatch } } : {}),
      // F-06: price range.
      ...priceFilter,
      // Multi-field query match (AND with the filters above).
      ...(queryOr ? { AND: [{ OR: queryOr }] } : {}),
    },
    take: RESULT_LIMIT,
    orderBy: orderByForCardSort(sort),
    select: {
      externalId: true,
      name: true,
      number: true,
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
    number: r.number ?? "",
    setImage: r.set?.name ?? "",
    rarity: r.rarity ?? "Unknown",
    hp: null,
    types: r.types ?? [],
    // One Piece: emit the best image from the fallback chain (clean stored
    // URL first, then CDN, then Bandai proxy). The client rebuilds the full
    // chain from the card code for <img onError> stepping.
    imageUrl:
      (game === "onepiece"
        ? onePieceImageChain(r.externalId, r.imageUrl, r.imageUrlHi)[0]
        : null) ??
      r.imageUrl ??
      r.imageUrlHi ??
      "",
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
