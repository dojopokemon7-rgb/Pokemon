/**
 * GET /api/cards/trending
 *
 * Returns a page of real, seeded cards from the local database for the
 * Explore tab's "Trending this week" grid.
 *
 * -------------------------------------------------------------------
 * WHY THIS EXISTS
 * -------------------------------------------------------------------
 * The Dojo prototype's "Trending this week" grid (searchEmpty() /
 * trendCard() in dojo-prototype/app.js) is backed by a hardcoded
 * 5-card mock array (CARD_DATA) — it was never meant to be a real
 * feed, just prototype filler. This app has a real Postgres-backed
 * card catalog (seeded via prisma/seed.ts, ~70+ real Pokémon/One Piece
 * cards), so the production version of this screen should read from
 * that instead of shipping 5 fixed Charizard variants forever.
 *
 * -------------------------------------------------------------------
 * "TRENDING" DEFINITION
 * -------------------------------------------------------------------
 * There is no real price-history/movers pipeline yet (PricingHistory
 * is currently empty — see schema.prisma). Until that exists, this
 * endpoint orders by `updatedAt desc` (most recently touched/seeded
 * cards first) as an honest, non-fabricated proxy for "trending" and
 * paginates through the full catalog rather than presenting a fixed
 * 5-card slice. Deltas are omitted (`null`) instead of invented —
 * the client renders "—" for cards with no real price/delta data.
 *
 * Query params:
 *   - `limit`  Optional. Page size, 1-50, default 10.
 *   - `cursor` Optional. Card `id` to page after (keyset pagination).
 *
 * Response (200):
 * ```json
 * {
 *   "cards": [
 *     { "id": "...", "name": "...", "setImage": "...", "imageUrl": "...",
 *       "price": 12.5, "delta": null, "up": null }
 *   ],
 *   "nextCursor": "clxyz..." | null
 * }
 * ```
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { redis } from "@/lib/redis";
import { CardSortEnum, orderByForCardSort, type CardSortKey } from "@/lib/utils/card-sort";

// A Card row with the set name joined — the shape every branch below
// produces (all use `include: { set: { select: { name: true } } }`).
type CardWithSetName = Prisma.CardGetPayload<{
  include: { set: { select: { name: true } } };
}>;

// Trending is the same query for every logged-in user (global feed
// ordered by updatedAt), so it's cheap to cache. Short TTL because
// the daily sync updates rows and we want new syncs to surface within
// a few minutes rather than the next hour.
const TRENDING_CACHE_SECONDS = 120;
function trendingCacheKey(
  game: string | undefined,
  limit: number,
  cursor: string | undefined,
  sort: CardSortKey
): string {
  return `card:trending:${game ?? "all"}:${sort}:${limit}:${cursor ?? "-"}`;
}

const TrendingQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  cursor: z.string().trim().min(1).optional(),
  // Client feedback fix: game filter so the Pokémon / One Piece tabs
  // don't leak cards from the other game (e.g. Charizard on One Piece).
  game: z.enum(["pokemon", "onepiece"]).optional(),
  // Shared with /api/cards/search — the client's filter sheet uses
  // one enum for both routes. Default is now "trending" (real
  // hot-right-now ranking by recent collection-adds).
  sort: CardSortEnum.default("trending"),
});

// "Hot right now" window: cards are ranked by how many collection-adds
// they received in the last N days. Wider window = steadier ranking but
// less "right now"; 7 days is the usual trending cadence.
// ponytail: fixed 7-day window, no decay curve — a recency-weighted
// score (e.g. exponential decay on addedAt) would be more precise but
// needs per-row math this simple count doesn't do. Upgrade when a real
// analytics pipeline exists.
const TRENDING_WINDOW_DAYS = 7;

/**
 * Ranks cards by real popularity: the number of UserCollection rows
 * (≈ distinct users, since @@unique([userId,cardId,isFoil]) caps a user
 * at 2 rows/card) added within the trending window. Returns an ordered
 * list of the top `take` cardIds. Empty when nobody has added anything
 * recently — the caller then falls back to the newest-synced order so
 * the grid is never blank on a fresh install.
 */
async function topTrendingCardIds(
  gameWhere: object,
  take: number
): Promise<string[]> {
  const since = new Date(Date.now() - TRENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const grouped = await prisma.userCollection.groupBy({
    by: ["cardId"],
    where: {
      addedAt: { gte: since },
      // Only rank cards that belong to the requested game's catalog.
      card: gameWhere,
    },
    _count: { cardId: true },
    orderBy: { _count: { cardId: "desc" } },
    take,
  });
  return grouped.map((g) => g.cardId);
}

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const parsed = TrendingQuerySchema.safeParse({
    limit: searchParams.get("limit") ?? undefined,
    cursor: searchParams.get("cursor") ?? undefined,
    game: searchParams.get("game") ?? undefined,
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

  const { limit, cursor, game, sort } = parsed.data;

  // Cursor pagination is keyset-on-`id`, which is only meaningful for
  // the default `updatedAt DESC` ordering. When the client picks any
  // other sort (or trending, which is a computed ranking), ignore the
  // cursor and return a fresh page 1 — the filter sheet reorders the
  // top of the feed, it doesn't scroll deep into a resorted list.
  const effectiveCursor = sort === "recent" ? cursor : undefined;
  const cacheKey = trendingCacheKey(game, limit, effectiveCursor, sort);
  // Best-effort cache lookup. Any Redis error (offline, timeout) falls
  // through to a live query rather than 500-ing on the user.
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return new NextResponse(cached, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "private, max-age=30, stale-while-revalidate=120",
        },
      });
    }
  } catch (err) {
    console.warn(
      "[cards/trending] Redis read failed, falling through:",
      err instanceof Error ? err.message : err
    );
  }

  try {
    // Game filter: prisma/seed.ts prefixes each CardSet.externalId with
    // `${game}-` (e.g. "pokemon-base-set-1st-edition" / "onepiece-op-01"),
    // so we filter by that prefix on the joined CardSet row. Cards added
    // by users via /api/users/me/collection use "user-added-*" and are
    // excluded from the game-filtered feed — that's fine, this endpoint
    // powers the "Trending" grid off the seeded catalog only.
    const gameFilter = game
      ? { set: { externalId: { startsWith: `${game}-` } } }
      : {};

    let rows: CardWithSetName[];
    let hasMore = false;

    if (sort === "trending") {
      // Real "hot right now": rank by recent collection-adds. Get the
      // top cardIds by add-count in the window, then fetch those cards
      // and re-order them to match the ranking (findMany `in` doesn't
      // preserve order). If fewer than a full page trend, backfill with
      // newest-synced cards so the grid is never sparse on low activity.
      const rankedIds = await topTrendingCardIds(gameFilter, limit);

      const ranked = rankedIds.length
        ? await prisma.card.findMany({
            where: { id: { in: rankedIds }, ...gameFilter },
            include: { set: { select: { name: true } } },
          })
        : [];
      // Restore the popularity order lost by the `in` query.
      const rankIndex = new Map(rankedIds.map((id, i) => [id, i]));
      ranked.sort((a, b) => (rankIndex.get(a.id)! - rankIndex.get(b.id)!));

      if (ranked.length >= limit) {
        rows = ranked.slice(0, limit);
        // There may be more trending cards than one page; report more.
        hasMore = rankedIds.length > limit;
      } else {
        // Backfill with newest-synced cards not already in the ranked set.
        const backfill = await prisma.card.findMany({
          where: { ...gameFilter, id: { notIn: ranked.map((c) => c.id) } },
          orderBy: [{ updatedAt: "desc" }],
          take: limit - ranked.length,
          include: { set: { select: { name: true } } },
        });
        rows = [...ranked, ...backfill];
        hasMore = false; // trending + backfill is a single curated page
      }
    } else {
      const fetched = await prisma.card.findMany({
        take: limit + 1, // fetch one extra to know if there's a next page
        ...(effectiveCursor ? { skip: 1, cursor: { id: effectiveCursor } } : {}),
        where: gameFilter,
        orderBy: orderByForCardSort(sort),
        include: { set: { select: { name: true } } },
      });
      hasMore = fetched.length > limit;
      rows = hasMore ? fetched.slice(0, limit) : fetched;
    }

    const page = rows;

    const cards = page.map((c) => ({
      // `id` is this row's internal database id — used for React keys,
      // the detail-page link, and this endpoint's own pagination
      // cursor. `externalId` is the *catalog* identity (the original
      // source API's card id, e.g. "base1-4") — this is what must be
      // sent back to POST /api/users/me/collection, so that adding a
      // trending card reuses the existing seeded Card row instead of
      // creating a duplicate keyed by the wrong id. A previous version
      // of this route only returned `id` and the client mistakenly
      // used it as `externalId`, silently duplicating every card added
      // from the trending grid.
      id: c.id,
      externalId: c.externalId,
      name: c.name,
      setImage: c.set?.name ?? "",
      imageUrl: c.imageUrl ?? c.imageUrlHi ?? null,
      price: c.marketPrice ?? null,
      // No real historical pricing data yet — never fabricate a delta.
      delta: null as string | null,
      up: null as boolean | null,
    }));

    const body = JSON.stringify({
      cards,
      // Keyset-on-`id` pagination is only correct for the updatedAt-desc
      // orders. Trending is a computed top-N ranking whose order doesn't
      // map to an id cursor, so it's a single curated page (no cursor).
      nextCursor:
        sort !== "trending" && hasMore ? page[page.length - 1].id : null,
    });

    // Cache write is best-effort; a Redis outage doesn't invalidate
    // the fresh query result we're about to return.
    try {
      await redis.set(cacheKey, body, "EX", TRENDING_CACHE_SECONDS);
    } catch (err) {
      console.warn(
        "[cards/trending] Redis write failed (non-fatal):",
        err instanceof Error ? err.message : err
      );
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, max-age=30, stale-while-revalidate=120",
      },
    });
  } catch (err) {
    console.error(
      "[cards/trending] Failed to load trending cards:",
      err instanceof Error ? err.message : err
    );
    return NextResponse.json(
      {
        error: "Internal Server Error",
        message: "Could not load trending cards.",
      },
      { status: 500 }
    );
  }
}
