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
import { prisma } from "@/lib/db";

const TrendingQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  cursor: z.string().trim().min(1).optional(),
});

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const parsed = TrendingQuerySchema.safeParse({
    limit: searchParams.get("limit") ?? undefined,
    cursor: searchParams.get("cursor") ?? undefined,
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

  const { limit, cursor } = parsed.data;

  try {
    const rows = await prisma.card.findMany({
      take: limit + 1, // fetch one extra to know if there's a next page
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { updatedAt: "desc" },
      include: { set: { select: { name: true } } },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

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

    return NextResponse.json(
      {
        cards,
        nextCursor: hasMore ? page[page.length - 1].id : null,
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "private, max-age=30, stale-while-revalidate=120",
        },
      }
    );
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
