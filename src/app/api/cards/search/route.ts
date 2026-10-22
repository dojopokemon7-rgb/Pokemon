/**
 * GET /api/cards/search
 *
 * Searches Pokémon or One Piece cards. Reads EXCLUSIVELY from the local
 * Supabase catalog (fully seeded) — no external API calls on the search
 * path. This makes user searches instant and eliminates the API-ban risk
 * that came with live-fetching on every keystroke.
 *
 * Query params:
 *   - `game`     Required. `"pokemon"` or `"onepiece"`.
 *   - `query`    Free-text search term. Optional ONLY when at least one filter
 *                below is set (browse mode: ordered by marketPrice desc);
 *                empty query + no filter → 400.
 *   - `sort`     Optional. Omitted or `trending` = RELEVANCE (exact id > exact
 *                number+set > exact name > prefix > typo > set/rarity; see
 *                search-rank.ts). Any other key (CardSortEnum) overrides it.
 *   - `set`      Optional (F-06). Filter to one set by name.
 *   - `rarity`   Optional (F-06). Filter by rarity (contains match).
 *   - `graded`   Optional (F-06). `"graded"` | `"ungraded"` — based on
 *                GRADED PRICING AVAILABILITY (does the card have a graded
 *                CurrentPrice row with a non-null price), NOT a card attribute.
 *   - `minPrice` Optional (F-06). Min marketPrice (USD).
 *   - `maxPrice` Optional (F-06). Max marketPrice (USD).
 *   - `hasPrice` Optional. `"true"`/`"1"` → keep ONLY cards that actually
 *                have a displayable price (NM/normal CurrentPrice OR
 *                Card.marketPrice — the SAME definition the tile uses).
 *                Omitted/falsey = unchanged (unpriced cards still appear).
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
import { auth } from "@/lib/auth";
import { requireAuth } from "@/lib/utils/auth-guard";
import { enforceRateLimit, searchTier, clientIp } from "@/lib/utils/rate-limit";
import { CardSortEnum, orderByForCardSort } from "@/lib/utils/card-sort";
import { onePieceImageChain } from "@/lib/utils/card-image";
import {
  NormalizedCardSchema,
  type NormalizedCard,
} from "@/lib/validators/card.validator";
import { RedisKeys, CACHE_TTL } from "@/lib/redis";
import { cacheGetJson, cacheSetJson } from "@/lib/utils/cache";
import { parseSearchQuery, isValidSearchRequest } from "@/lib/utils/search-query";
import { ScanLanguageSchema } from "@/lib/utils/scan-language";
import { rankCards, hasNameHit } from "@/lib/utils/search-rank";
import { pickHeadlineRaw } from "@/lib/utils/raw-price";
import { isSearchIndexEnabled, searchIndexIds } from "@/lib/services/card-search-index.service";

/** Flip to `true` to gate search behind a valid Better Auth session. */
const ENFORCE_AUTH = false;

/** Cap results at a sensible page — the UI grid renders ~60 tiles well. */
const RESULT_LIMIT = 60;

const SearchQuerySchema = z.object({
  game: z.enum(["pokemon", "onepiece"]),
  // Optional (browse mode): an empty/omitted query is valid ONLY when at least
  // one filter is present (see the .refine below).
  query: z.string().trim().max(100, "query is too long").optional().default(""),
  // Optional: omitted (or the UI default "trending") = relevance ranking.
  sort: CardSortEnum.optional(),
  // F-06: optional set filter. Matches on the joined CardSet.name (that's
  // the label the UI shows on each tile and in the filter dropdown).
  set: z.string().trim().min(1).max(100).optional(),
  // F-06: optional rarity filter — matches on Card.rarity (case-insensitive).
  rarity: z.string().trim().min(1).max(50).optional(),
  // F-06 (QA D5): graded-pricing-availability filter. "graded" → the card has
  // at least one graded CurrentPrice row with a non-null price; "ungraded" →
  // it has none; omitted → both. (Grading is NOT a catalog-card attribute — it
  // belongs to a user's owned copy — so the filter means "has graded pricing
  // data available", which IS a real catalog signal.)
  graded: z.enum(["graded", "ungraded"]).optional(),
  // F-06: price range on Card.marketPrice (USD). Coerced from query strings;
  // non-numeric/negative values are rejected.
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  // Opt-in "has price data" filter. "true"/"1" → only cards with a
  // displayable price; omitted → unchanged (unpriced cards still show).
  // Parsed as a string flag (like `graded`) rather than z.coerce.boolean
  // (which treats any non-empty string as true), so only the explicit
  // truthy values turn it on.
  hasPrice: z.enum(["true", "1"]).optional(),
  // Language filter. There is NO language column on Card — language is
  // inferred from the externalId: Japanese cards contain the literal
  // substring "_ja-" (e.g. "bw1b_ja-3"), English/other cards do not
  // (e.g. "xy7-57"). `all` (default/omitted) applies no predicate.
  language: ScanLanguageSchema.optional(),
  // Offset cursor: how many items the client has already loaded. Coerced to a
  // non-negative int; absent → page 1 (offset 0). Mirrors /api/cards/trending
  // so the results grid can page past the first RESULT_LIMIT instead of being
  // hard-capped (audit 02 F-T). Offset pagination (`skip: cursor`) composes
  // with every sort order without re-serving page 1 (AGENTS.md RULE 12).
  cursor: z.coerce.number().int().min(0).default(0),
}).refine(isValidSearchRequest, {
  path: ["query"],
  message: "query must not be empty unless a filter is set",
});

export async function GET(request: Request): Promise<NextResponse> {
  if (ENFORCE_AUTH) {
    const guard = await requireAuth(request);
    if (guard.unauthorized) return guard.unauthorized;
  }

  // Rate-limit the search path BEFORE the query parse / DB work. Search is
  // public (ENFORCE_AUTH=false), so best-effort resolve the session to key by
  // user id when present (one abusive account is capped regardless of IP), else
  // fall back to the client IP. The session read is fail-open (any error → IP).
  let identity: Parameters<typeof enforceRateLimit>[2];
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    identity = session?.user?.id
      ? { kind: "user", id: session.user.id }
      : { kind: "ip", id: clientIp(request) };
  } catch {
    identity = { kind: "ip", id: clientIp(request) };
  }
  const limited = await enforceRateLimit(request, searchTier(), identity);
  if (limited) return limited;

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
    hasPrice: searchParams.get("hasPrice") ?? undefined,
    language: searchParams.get("language") ?? undefined,
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

  const { game, query, set, rarity, graded, minPrice, maxPrice, hasPrice, language, cursor } = parsed.data;
  const sort = parsed.data.sort ?? "trending";
  const relevance = sort === "trending";
  // Offset pagination (audit 02 F-T): page past the first RESULT_LIMIT.
  const offset = cursor;

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
    hasPrice,
    language,
    // Page segment: page 2 (cursor=60) must never be served page 1's cache
    // (mirrors trending embedding offset in its key — audit 02 F-T).
    cursor: offset,
  });
  const cached = await cacheGetJson<{ cards: unknown[]; source: string; nextCursor?: number | null }>(cacheKey);
  if (cached) {
    // Re-validate the cached cards with the SAME schema the live path uses; a
    // parse failure is treated as a miss (fall through to live), never served.
    const revalidated = z.array(NormalizedCardSchema).safeParse(cached.cards);
    if (revalidated.success) {
      return NextResponse.json(
        { cards: revalidated.data, source: cached.source, nextCursor: cached.nextCursor ?? null },
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

  // F-06 (QA D5) graded-pricing-availability: a card counts as "graded" when it
  // has at least one graded CurrentPrice row with a non-null price (the SAME
  // shape the enrich route reads: `type:"graded", priceMarket:{ not:null }`),
  // "ungraded" is the negation. Grading is NOT a card attribute — the old
  // rarity-startsWith check matched the seed-test "PSA 10" rarities but NOTHING
  // in the real Scrydex catalog (rarities are "Rare Holo", "Common", …), so it
  // returned zero rows. This relation query is a real, honest catalog signal.
  // It sits at the TOP LEVEL of baseWhere (a single `currentPrices` key for
  // graded, a single top-level `NOT` for ungraded) — the only other top-level
  // `NOT` user (language `en`) nests under `AND`, and the hasPrice filter's
  // `currentPrices` also nests under `AND`, so neither collides with this.
  const GRADED_PRICING = {
    currentPrices: { some: { type: "graded", priceMarket: { not: null } } },
  } as const;

  // F-06 price range — audit 02 F-F. The tile DISPLAYS
  // `pickHeadlineRaw(currentPrices type:"raw") ?? marketPrice` (see the
  // `cards.map` below), so the range filter MUST predicate on that SAME
  // displayed value, not on Card.marketPrice alone. The old marketPrice-only
  // gte/lte wrongly EXCLUDED a card with null marketPrice but a real raw
  // CurrentPrice in range, and could KEEP a card whose displayed raw price
  // falls outside the requested range. This predicate mirrors the hasPrice
  // OR-structure exactly:
  //   • arm 1 — a raw CurrentPrice row with priceMarket in bounds (the price
  //     the tile actually shows); OR
  //   • arm 2 — marketPrice in bounds, but ONLY when the card has NO raw
  //     priceMarket row (`currentPrices.none`), i.e. exactly the fallback the
  //     tile uses. The `none` guard stops a card with an out-of-range raw row
  //     from sneaking in on its marketPrice, and stops double-counting a card
  //     that has a raw row.
  // ponytail: `currentPrices.some/none.priceMarket` is an un-indexed relation
  // scan, bounded here by the already-filtered paginated take (≤300/600/60);
  // upgrade = an index on CurrentPrice.priceMarket.
  const bounds = {
    ...(minPrice != null ? { gte: minPrice } : {}),
    ...(maxPrice != null ? { lte: maxPrice } : {}),
  };
  const priceRangeFilter: Prisma.CardWhereInput =
    minPrice != null || maxPrice != null
      ? {
          AND: [
            {
              OR: [
                { currentPrices: { some: { type: "raw", priceMarket: bounds } } },
                {
                  AND: [
                    { currentPrices: { none: { type: "raw", priceMarket: { not: null } } } },
                    { marketPrice: bounds },
                  ],
                },
              ],
            },
          ],
        }
      : {};

  // "Has price data" filter: keep ONLY cards that have a DISPLAYABLE price.
  // This OR MUST mirror the tile's `pickHeadlineRaw(currentPrices) ??
  // marketPrice ?? null` definition below exactly — a card shown with a
  // price must never be hidden, and a card kept here must always render a
  // price. Wrapped in its OWN nested `AND` so it composes with (never
  // clobbers) the sibling `graded` top-level OR and the relevance path's
  // `AND:[{OR:or}]`, which all spread into `baseWhere` in find().
  const hasPriceFilter: Prisma.CardWhereInput = hasPrice
    ? {
        AND: [
          {
            OR: [
              { marketPrice: { not: null } },
              {
                currentPrices: {
                  some: { type: "raw", priceMarket: { not: null } },
                },
              },
            ],
          },
        ],
      }
    : {};

  // Language filter. Language is NOT a column — it's encoded in the externalId:
  // Japanese cards contain the literal substring "_ja-" (e.g. "bw1b_ja-3"),
  // English/other cards do not (e.g. "xy7-57"). The underscore is a SQL LIKE
  // single-char wildcard, so it MUST be escaped to match literally: the JS
  // string "\\_ja-" is the two chars `\` + `_`, which Prisma's `contains`
  // compiles to Postgres LIKE '%\_ja-%' (default escape char `\`) — matching a
  // literal "_ja-" and NOT e.g. "Xja-". ponytail: this is a filtered LIKE scan
  // over externalId (fine inside the already-filtered, paginated query — the
  // bounded take:300/600/60 caps it); upgrade path if the catalog grows or this
  // becomes hot = a partial/expression index on `externalId LIKE '%\_ja-%'`, or
  // a generated boolean `isJapanese` column.
  const JA_MARKER = "\\_ja-";
  // The `en` branch keys on top-level `NOT`, which the sibling
  // `graded==="ungraded"` branch ALSO uses — a plain spread would let one
  // clobber the other (last key wins), silently dropping a filter. So the
  // language predicate is nested under its OWN `AND` (same technique as
  // `hasPriceFilter`), and the `AND`-carrying fragments are merged by concat
  // in `baseWhere` below rather than spread, so neither `AND` is lost.
  const languageFilter: Prisma.CardWhereInput =
    language === "ja"
      ? { AND: [{ externalId: { contains: JA_MARKER } }] }
      : language === "en"
        ? { AND: [{ NOT: { externalId: { contains: JA_MARKER } } }] }
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

  // Prisma's `AND` is `T | T[] | undefined`; normalize to an array so the
  // nested-AND fragments (hasPrice, language) and the relevance path's
  // `extra.AND` can be concatenated uniformly without one clobbering another.
  const toArray = (
    v: Prisma.CardWhereInput["AND"]
  ): Prisma.CardWhereInput[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

  // Image-presence exclusion (findings Bug 1): the catalog holds ~71 imageless,
  // priceless rows (incl. 28 exu-* Unown and a stray "mega darkrai") that must
  // NEVER appear in search. Image presence is the SAFE exclusion — exclude on
  // `imageUrl` ONLY, never marketPrice/price: 5,843 legit cards have a null
  // Card.marketPrice but a real CurrentPrice NM row, so a price gate would hide
  // them. These two clauses are UNCONDITIONAL (not behind hasPrice/language) and
  // live in their OWN nested `AND` fragment so they ride the same `AND` concat
  // as hasPrice/language and NEVER clobber the graded top-level
  // `currentPrices` / `NOT:{currentPrices}` or the language `NOT`.
  const imagePresentFilter: Prisma.CardWhereInput = {
    AND: [{ imageUrl: { not: null } }, { NOT: { imageUrl: "" } }],
  };

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
    // F-06 (QA D5): graded → card HAS graded pricing; ungraded → it doesn't.
    ...(graded === "graded" ? GRADED_PRICING : {}),
    ...(graded === "ungraded" ? { NOT: GRADED_PRICING } : {}),
    // "Has price data", the F-F display-price range, Language, and the
    // unconditional image-presence filter all use a nested `AND` (so their
    // top-level `NOT`/`OR` never clobber the graded top-level
    // `currentPrices`/`NOT`). Spreading them would let one `AND` key overwrite
    // another, so their clauses are concatenated into ONE `AND` array here. The
    // price range is folded in HERE (not spread as a top-level marketPrice key)
    // for the same reason — its `OR` arm references `currentPrices`, so a
    // top-level spread would collide with the graded `currentPrices`. The
    // image-presence clauses are ALWAYS folded in (imagePresentFilter has no
    // opt-in gate); `all` language and an absent price range contribute empty
    // objects → no clause.
    AND: [
      ...toArray(hasPriceFilter.AND),
      ...toArray(priceRangeFilter.AND),
      ...toArray(languageFilter.AND),
      ...toArray(imagePresentFilter.AND),
    ],
  };

  // `skip` defaults to 0 so the internal pool fetches (relevance 300/600,
  // Typesense hydrate) are unaffected — only the two response-producing
  // branches (browse, explicit-sort) pass `skip: offset` for pagination.
  const find = (
    extra: Prisma.CardWhereInput,
    take: number,
    orderBy: Prisma.CardOrderByWithRelationInput[],
    skip = 0
  ) =>
    prisma.card.findMany({
      // Merge `AND` arrays instead of letting the spread overwrite: both
      // baseWhere (hasPrice) and the relevance/sort path (`extra.AND:[{OR}]`)
      // can carry `AND`, and a plain `{...baseWhere, ...extra}` would drop
      // whichever came first. Concatenating keeps BOTH clauses (hasPrice AND
      // the query OR) so neither filter is silently weakened.
      where: {
        ...baseWhere,
        ...extra,
        ...((baseWhere.AND || extra.AND)
          ? { AND: [...toArray(baseWhere.AND), ...toArray(extra.AND)] }
          : {}),
      },
      take,
      skip,
      orderBy,
      select: {
        externalId: true,
        name: true,
        number: true,
        // Per-printing parity (FEAT-004): the variant label for this row.
        printing: true,
        rarity: true,
        types: true,
        tags: true,
        imageUrl: true,
        imageUrlHi: true,
        marketPrice: true,
        // REAL 7-day price change (Scrydex trends.days_7) — surfaced on the
        // tile as its movement indicator, null when absent (never fabricated).
        weeklyChangePct: true,
        // RAW CurrentPrice rows (type:"raw" ONLY — legacy graded rows also carry
        // condition "NM"), reduced by the SAME pickHeadlineRaw the card-detail
        // page uses so list and details never disagree. Many cards have a real
        // raw row while Card.marketPrice is still null (e.g. One Piece "Perfect
        // Order"). Bounded: ~<=25 raw rows/card on current_price @@index([cardId]).
        currentPrices: {
          where: { type: "raw" },
          select: { variant: true, type: true, condition: true, company: true, grade: true, priceMarket: true, priceLow: true },
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
      // The full Bandai code the user typed (e.g. "OP01-120") IS the stored
      // Card.number on EVERY printing of that card (base + ::foil/::altArt/…).
      // Match it directly so all printings enter the pool — after the set
      // reconcile the set externalId is a slug ("onepiece-romance-dawn"), so the
      // old "number + set.externalId contains <code>" clause no longer catches
      // the variants (their set code isn't in the slug). This per-printing-safe
      // number match is what surfaces foil/alt-art/manga alongside the base.
      const fullCode = `${a}-${b}`; // "op01" + "120" → "op01-120"
      or.push(
        { number: { contains: fullCode, ...insens } },
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
  // Offset pagination (audit 02 F-T): each branch produces an EXACT page of at
  // most RESULT_LIMIT rows and a `hasMore` flag. The DB branches (explicit-sort,
  // browse) fetch `take: RESULT_LIMIT + 1` with `skip: offset` and detect a
  // further page from the extra row (same technique as /api/cards/trending);
  // the relevance branch slices its already-ranked in-memory pool.
  let hasMore = false;
  if (!relevance) {
    // Explicit sort overrides relevance: the original single query, now
    // DB-paginated by `skip: offset` (composes with any orderBy — RULE 12).
    const fetched = await find(
      queryOr ? { AND: [{ OR: queryOr }] } : {},
      RESULT_LIMIT + 1,
      orderByForCardSort(sort),
      offset
    );
    hasMore = fetched.length > RESULT_LIMIT;
    rows = hasMore ? fetched.slice(0, RESULT_LIMIT) : fetched;
  } else if (!query) {
    // Browse mode (empty query + filter): no name matching or relevance
    // ranking — most valuable first, same ordering as the relevance pools.
    // DB-paginated (this is the reported large-set case, e.g. ?set=Base).
    const fetched = await find(
      {},
      RESULT_LIMIT + 1,
      [
        { marketPrice: { sort: "desc", nulls: "last" } },
        { externalId: "asc" },
      ],
      offset
    );
    hasMore = fetched.length > RESULT_LIMIT;
    rows = hasMore ? fetched.slice(0, RESULT_LIMIT) : fetched;
  } else {
    // Relevance: the pool is already fully materialized and ranked in JS, and
    // bounded (max ~300/600 ranked rows — NOT a full-catalog scan), so page by
    // slicing the ranked array. `hasMore` stays true until that bounded pool is
    // exhausted; it does not promise results beyond the pool ceiling.
    const ranked = await relevantRows(query);
    hasMore = ranked.length > offset + RESULT_LIMIT;
    rows = ranked.slice(offset, offset + RESULT_LIMIT);
  }
  // Single next-page cursor for all three branches: the running OFFSET (items
  // loaded so far), or null when there is no further page.
  const nextCursor = hasMore ? offset + rows.length : null;
  if (rows.length === 0) {
    return NextResponse.json(
      {
        error: "Not Found",
        message: query
          ? `No local matches for "${query}". The daily sync may not have reached this set yet.`
          : "No local matches for these filters.",
        source: "local-db",
      },
      { status: 404 }
    );
  }

  // Match the pre-existing NormalizedCard envelope so no client changes
  // are required. `hp` is null: the schema doesn't store it — that
  // column would need to be added if the UI ever needs HP again.
  // Each branch above already produced an exact page (≤ RESULT_LIMIT), so no
  // trailing slice — map `rows` directly.
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
    // List price = shared raw derivation (NM, else LP->MP->HP->DM; never
    // graded), falls back to the cached Card.marketPrice, else null → '—'.
    // Stays number|null (never a fabricated 0) so NormalizedCardSchema — and
    // this route's cached-payload re-parse — still validate.
    marketPrice: pickHeadlineRaw(r.currentPrices ?? []) ?? r.marketPrice ?? null,
    // Per-printing parity (FEAT-004): surface the variant label so each
    // printing result is distinguishable ("Alt Art" / "foil"). Null for
    // rows with no stored printing — the tile then shows nothing extra.
    printing: r.printing ?? null,
    // REAL 7-day change — the tile renders a movement indicator ONLY when
    // this is non-null; null → no indicator (AGENTS.md rule 2, never a
    // fabricated delta derived from the card id).
    weeklyChangePct: r.weeklyChangePct ?? null,
  }));

  // Best-effort cache fill. Only non-empty 200s reach here (zero rows returned
  // a 404 above and is NOT cached, so a mid-sync empty result isn't pinned).
  await cacheSetJson(cacheKey, { cards, source: "local-db", nextCursor }, CACHE_TTL.cardSearch);

  return NextResponse.json(
    { cards, source: "local-db", nextCursor },
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
