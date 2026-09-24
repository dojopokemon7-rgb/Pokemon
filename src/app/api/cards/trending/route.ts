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
 *   - `cursor` Optional. Numeric OFFSET (count of items already loaded) to
 *              page after. Offset pagination works identically for every
 *              sort order (name/market/recent), unlike keyset-on-`id` which
 *              only lined up with `updatedAt` order and silently re-served
 *              page 1 for the other sorts (F-04 duplicate-cards bug).
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

// Only the columns the response mapping actually reads. `include: { set }`
// used to pull every Card + CardSet column (hi-res URLs, lastEbayPrice,
// audit timestamps, set logo/symbol/release date) on every trending row —
// dead payload the grid never renders. This narrow select is the exact
// projection the `cards.map(...)` below consumes.
const TRENDING_SELECT = {
  id: true,
  externalId: true,
  name: true,
  imageUrl: true,
  imageUrlHi: true,
  marketPrice: true,
  rarity: true,
  set: { select: { name: true } },
} satisfies Prisma.CardSelect;

// A Card row narrowed to the fields the trending grid renders — the shape
// every branch below produces (all use `select: TRENDING_SELECT`).
type CardWithSetName = Prisma.CardGetPayload<{
  select: typeof TRENDING_SELECT;
}>;

// Trending is the same query for every logged-in user (global feed
// ordered by updatedAt), so it's cheap to cache. Short TTL because
// the daily sync updates rows and we want new syncs to surface within
// a few minutes rather than the next hour.
const TRENDING_CACHE_SECONDS = 120;
function trendingCacheKey(
  game: string | undefined,
  limit: number,
  offset: number,
  sort: CardSortKey
): string {
  return `card:trending:${game ?? "all"}:${sort}:${limit}:${offset}`;
}

const TrendingQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  // Offset cursor: how many items the client has already loaded. Coerced
  // to a non-negative int; absent → page 1 (offset 0).
  cursor: z.coerce.number().int().min(0).optional(),
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

  // Offset pagination is honored for EVERY sort — `skip: offset` composes
  // with any orderBy, so page 2 never re-includes page 1 (F-04 fix).
  // Trending now paginates too: page 1 (offset 0) is the curated
  // ranked+backfill grid; page 2+ continues through the catalog so users
  // can browse past the first page instead of being capped at one page.
  const offset = cursor ?? 0;
  const cacheKey = trendingCacheKey(game, limit, offset, sort);
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

    if (sort === "trending" && offset === 0) {
      // PAGE 1 of the trending sort — the curated "hot right now" grid.
      // Rank by recent collection-adds, then fetch + re-order those cards
      // (findMany `in` doesn't preserve order). If fewer than a full page
      // trend, backfill with newest-synced cards so the grid is never
      // sparse on low activity.
      const rankedIds = await topTrendingCardIds(gameFilter, limit);

      const ranked = rankedIds.length
        ? await prisma.card.findMany({
            where: { id: { in: rankedIds }, ...gameFilter },
            select: TRENDING_SELECT,
          })
        : [];
      // Restore the popularity order lost by the `in` query.
      const rankIndex = new Map(rankedIds.map((id, i) => [id, i]));
      ranked.sort((a, b) => (rankIndex.get(a.id)! - rankIndex.get(b.id)!));

      if (ranked.length >= limit) {
        rows = ranked.slice(0, limit);
      } else {
        // Backfill with newest-synced cards not already in the ranked set.
        const backfill = await prisma.card.findMany({
          where: { ...gameFilter, id: { notIn: ranked.map((c) => c.id) } },
          orderBy: [{ updatedAt: "desc" }],
          take: limit - ranked.length,
          select: TRENDING_SELECT,
        });
        rows = [...ranked, ...backfill];
      }
      // "More" if the catalog holds cards beyond this first page. Page 2+
      // browses the catalog by `updatedAt desc` (the backfill order) so
      // Show More keeps loading rather than dead-ending at one page.
      const total = await prisma.card.count({ where: gameFilter });
      hasMore = total > rows.length;
    } else if (sort === "trending") {
      // PAGE 2+ of the trending sort — plain catalog pagination by the
      // same `updatedAt desc` order page 1's backfill used, so it composes
      // with page 1 without re-serving the same cards up front.
      const fetched = await prisma.card.findMany({
        take: limit + 1, // one extra to detect a further page
        skip: offset,
        where: gameFilter,
        orderBy: [{ updatedAt: "desc" }],
        select: TRENDING_SELECT,
      });
      hasMore = fetched.length > limit;
      rows = hasMore ? fetched.slice(0, limit) : fetched;
    } else {
      const fetched = await prisma.card.findMany({
        take: limit + 1, // fetch one extra to know if there's a next page
        skip: offset, // offset pagination — correct for any orderBy
        where: gameFilter,
        orderBy: orderByForCardSort(sort),
        select: TRENDING_SELECT,
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
      // Graded-ness rides on `rarity` ("PSA 10") — the popup uses it to
      // open the graded add flow (F-19). No dedicated grade column yet.
      rarity: c.rarity ?? null,
      // No real historical pricing data yet — never fabricate a delta.
      delta: null as string | null,
      up: null as boolean | null,
    }));

    const body = JSON.stringify({
      cards,
      // Next-page cursor is the running OFFSET (items loaded so far). Every
      // sort — trending included now — pages via `skip: offset`, so this
      // composes correctly with any order and lets "Show More" advance.
      nextCursor: hasMore ? offset + page.length : null,
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
