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
 *   - `sort`     Optional. Omitted or `trending` = RELEVANCE (exact id > exact
 *                number+set > exact name > prefix > typo > set/rarity; see
 *                search-rank.ts). Any other key (CardSortEnum) overrides it.
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
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/utils/auth-guard";
import { CardSortEnum, orderByForCardSort } from "@/lib/utils/card-sort";
import { onePieceImageChain } from "@/lib/utils/card-image";
import {
  NormalizedCardSchema,
  type NormalizedCard,
} from "@/lib/validators/card.validator";
import { RedisKeys, CACHE_TTL } from "@/lib/redis";
import { cacheGetJson, cacheSetJson } from "@/lib/utils/cache";
import { parseSearchQuery } from "@/lib/utils/search-query";
import { rankCards, hasNameHit } from "@/lib/utils/search-rank";
import { isSearchIndexEnabled, searchIndexIds } from "@/lib/services/card-search-index.service";

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
  // Optional: omitted (or the UI default "trending") = relevance ranking.
  sort: CardSortEnum.optional(),
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

  const { game, query, set, rarity, graded, minPrice, maxPrice } = parsed.data;
  const sort = parsed.data.sort ?? "trending";
  const relevance = sort === "trending";

  // USER-AGNOSTIC cache (RULE 3 — the catalog result is identical for every
  // user, so NO userId in the key; sharing it is the point). Keyed by the
  // PARSED+normalized params (query lowercased) so ?query=Char and ?query=char
  // collide. A Redis fault / malformed payload falls through to the live query.
  const cacheKey = RedisKeys.cardSearchResult({
    game,
    query,
    // "rel-v2" versions the relevance ranker so old market_desc entries are not served.
    sort: relevance ? "rel-v2" : sort,
    set,
    rarity,
    graded,
    minPrice,
    maxPrice,
  });
  const cached = await cacheGetJson<{ cards: unknown[]; source: string }>(cacheKey);
  if (cached) {
    // Re-validate the cached cards with the SAME schema the live path uses; a
    // parse failure is treated as a miss (fall through to live), never served.
    const revalidated = z.array(NormalizedCardSchema).safeParse(cached.cards);
    if (revalidated.success) {
      return NextResponse.json(
        { cards: revalidated.data, source: cached.source },
        {
          status: 200,
          headers: {
            "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
          },
        }
      );
    }
  }

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

  // Shared filter fragment: EVERY candidate query (legacy, pool, typo recall,
  // index hydration) ANDs this in, so filters are never weakened.
  const baseWhere: Prisma.CardWhereInput = {
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
  };

  const find = (extra: Prisma.CardWhereInput, take: number, orderBy: Prisma.CardOrderByWithRelationInput[]) =>
    prisma.card.findMany({
      where: { ...baseWhere, ...extra },
      take,
      orderBy,
      select: {
        externalId: true,
        name: true,
        number: true,
        rarity: true,
        types: true,
        tags: true,
        imageUrl: true,
        imageUrlHi: true,
        marketPrice: true,
        // Prefer the raw NM/normal CurrentPrice — the SAME source the
        // card-detail prices route reads. Many cards have a real NM price row
        // while Card.marketPrice is still null, so selecting only marketPrice
        // made priced cards (e.g. One Piece "Perfect Order") show "No price
        // data". Bounded (take:1, uses current_price @@index([cardId])) — no N+1.
        currentPrices: {
          where: { variant: "normal", condition: "NM" },
          select: { priceMarket: true },
          take: 1,
        },
        set: { select: { name: true } },
      },
    });
  type Row = Awaited<ReturnType<typeof find>>[number];

  /** Relevance path: bounded candidate pools, ranked in JS (search-rank.ts). */
  async function relevantRows(q: string): Promise<Row[]> {
    const p = parseSearchQuery(q);
    const byPrice: Prisma.CardOrderByWithRelationInput[] = [
      { marketPrice: { sort: "desc", nulls: "last" } },
      { externalId: "asc" },
    ];
    const rank = (list: Row[]) => rankCards(p, list.map((r) => ({ ...r, setName: r.set?.name ?? null })));
    const insens = { mode: "insensitive" as const };

    // Optional Typesense: ids only; rows are hydrated from Postgres with the
    // SAME filters (Postgres stays authoritative). Any failure → Postgres path.
    if (isSearchIndexEnabled() && !p.identifierLike) {
      try {
        const ids = await searchIndexIds({ game, query: q, set, rarity, minPrice, maxPrice, limit: RESULT_LIMIT });
        if (ids && ids.length > 0) {
          const hydrated = await find({ externalId: { in: ids } }, RESULT_LIMIT, byPrice);
          if (hydrated.length > 0) {
            const order = new Map(ids.map((id, i) => [id, i]));
            return hydrated.sort((a, b) => order.get(a.externalId)! - order.get(b.externalId)!);
          }
        }
      } catch {
        /* fall through to Postgres */
      }
    }

    // Stage 1: bounded pool (300). Raw + accent-folded terms.
    const terms = [...new Set([q.trim(), p.norm, ...p.tokens.filter((t) => t.length >= 2)])];
    const [a, b] = p.tokens;
    const or: Prisma.CardWhereInput[] = p.idCandidates.map((id) => ({ externalId: { equals: id, ...insens } }));
    if (p.identifierLike) {
      or.push(
        { AND: [{ number: { contains: b } }, { set: { externalId: { contains: a } } }] },
        { AND: [{ name: { contains: a, ...insens } }, { number: { contains: b } }] },
        { name: { contains: p.norm, ...insens } }
      );
    } else {
      for (const n of p.numberCandidates) or.push({ number: { contains: n, ...insens } });
      for (const t of terms) {
        or.push({ name: { contains: t, ...insens } }, { set: { name: { contains: t, ...insens } } });
        or.push({ set: { externalId: { contains: t.toLowerCase() } } });
      }
      for (const t of p.tokens) or.push({ tags: { has: t } });
    }
    let pool = await find({ AND: [{ OR: or }] }, 300, byPrice);
    let ranked = rank(pool);

    // Stage 2: typo/accent recall via a 2-char name-prefix pool (600). Never
    // for identifier queries (they must not fuzzy-match another id).
    const longest = [...p.tokens].sort((x, y) => y.length - x.length)[0] ?? "";
    if (!p.identifierLike && longest.length >= 2 && !hasNameHit(p, ranked)) {
      const extra = await find({ name: { startsWith: longest.slice(0, 2), ...insens } }, 600, byPrice);
      const seen = new Set(pool.map((r) => r.externalId));
      pool = [...pool, ...extra.filter((r) => !seen.has(r.externalId))];
      ranked = rank(pool);
    }
    return ranked;
  }

  let rows: Row[];
  if (!relevance) {
    // Explicit sort overrides relevance: the original single query.
    rows = await find(queryOr ? { AND: [{ OR: queryOr }] } : {}, RESULT_LIMIT, orderByForCardSort(sort));
  } else {
    rows = await relevantRows(query);
  }
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
  const cards: NormalizedCard[] = rows.slice(0, RESULT_LIMIT).map((r) => ({
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
    // List price prefers the NM CurrentPrice (same source the detail route
    // reads), falls back to the cached Card.marketPrice, else null → '—'.
    // Stays number|null (never a fabricated 0) so NormalizedCardSchema — and
    // this route's cached-payload re-parse — still validate.
    marketPrice: r.currentPrices?.[0]?.priceMarket ?? r.marketPrice ?? null,
  }));

  // Best-effort cache fill. Only non-empty 200s reach here (zero rows returned
  // a 404 above and is NOT cached, so a mid-sync empty result isn't pinned).
  await cacheSetJson(cacheKey, { cards, source: "local-db" }, CACHE_TTL.cardSearch);

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
