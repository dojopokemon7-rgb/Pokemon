/**
 * Card Service — Multi-Source Search with Redundant Fallback
 *
 * This is the heart of the data layer. A single public call,
 * {@link searchCards}, resolves to a {@link NormalizedSearchResponse}
 * by trying several external TCG APIs in priority order until one
 * returns usable data.
 *
 * Flow:
 *   1. Check Redis cache (`card:search:{game}:{query}`). Hit → return immediately.
 *   2. Miss → run the fallback chain for the requested game.
 *   3. Each task fetches from one API and normalizes via {@link NormalizedCardSchema}.
 *   4. The winning result is validated, written to cache (24h TTL), and returned.
 *
 * All raw external payloads are treated as `unknown` and funneled through
 * Zod at the adapter boundary, so no unvalidated shape ever reaches a
 * route handler.
 *
 * @module card.service
 */

import { redis, RedisKeys } from "@/lib/redis";
import { executeWithFallback, NoResultsError } from "@/lib/utils/fallback-executor";
import {
  NormalizedCardSchema,
  NormalizedSearchResponseSchema,
  type NormalizedCard,
  type NormalizedSearchResponse,
} from "@/lib/validators/card.validator";

// =============================================================
// Shared Fetch Config
// =============================================================

/** Base headers sent on every outbound request — JSON + a UA for API politeness. */
const FETCH_HEADERS: HeadersInit = {
  Accept: "application/json",
  "User-Agent": "TCG-Collection-PWA/0.1 (+https://example.com)",
};

// =============================================================
// Public API
// =============================================================

/**
 * Searches cards for the requested game, using cache + fallbacks.
 *
 * @param game  `"pokemon"` or `"onepiece"`.
 * @param query Free-text search term (e.g. `"charizard"`, `"luffy"`).
 * @returns A validated {@link NormalizedSearchResponse}.
 * @throws {Error} if every fallback source fails (the route handler maps this to 404/502).
 */
export async function searchCards(
  game: "pokemon" | "onepiece",
  query: string
): Promise<NormalizedSearchResponse> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { cards: [], source: "none" };
  }

  // ------------------------------------------------------------
  // 1. Cache lookup
  // ------------------------------------------------------------
  const cacheKey = RedisKeys.cardSearch(game, trimmed);
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      console.log(
        `[CardService] Cache HIT for game="${game}" query="${trimmed}"`
      );
      // Cache stores a pre-validated payload; re-validate defensively.
      return NormalizedSearchResponseSchema.parse(JSON.parse(cached));
    }
    console.log(
      `[CardService] Cache MISS for game="${game}" query="${trimmed}"`
    );
  } catch (err) {
    // A cache read error must NOT abort the request — fall through to live fetch.
    console.warn(
      "[CardService] Cache read failed, proceeding to live fallbacks:",
      err instanceof Error ? err.message : err
    );
  }

  // ------------------------------------------------------------
  // 2. Live fallback chain
  // ------------------------------------------------------------
  const result =
    game === "pokemon"
      ? await searchPokemonCards(trimmed)
      : await searchOnePieceCards(trimmed);

  // ------------------------------------------------------------
  // 3. Cache write (best-effort, never blocks the response)
  // ------------------------------------------------------------
  try {
    await redis.set(cacheKey, JSON.stringify(result), "EX", 86_400); // 24h
    console.log(
      `[CardService] Cached result from source="${result.source}" (TTL 24h)`
    );
  } catch (err) {
    console.warn(
      "[CardService] Cache write failed (non-fatal):",
      err instanceof Error ? err.message : err
    );
  }

  return result;
}

/** Convenience wrapper exported for explicit Pokemon-only callers. */
export async function searchPokemonCards(
  query: string
): Promise<NormalizedSearchResponse> {
  // Source order was chosen empirically:
  //  1. Pokémon TCG API  — richest payload (rarity/hp/types/set + working images).
  //  2. TCGdex           — good breadth, but the list view omits rarity/hp/types.
  //  3. Scrydex          — community aggregator; last resort.
  return executeWithFallback([
    { name: "pokemon-tcg", task: () => fetchPokemonTcg(query) },
    { name: "tcgdex", task: () => fetchTcgdex(query) },
    { name: "scrydex-pokemon", task: () => fetchScrydexPokemon(query) },
  ]);
}

/** Convenience wrapper exported for explicit One Piece-only callers. */
export async function searchOnePieceCards(
  query: string
): Promise<NormalizedSearchResponse> {
  // One Piece chain (real data only — client explicitly rejected mocks):
  //   1. apitcg.com/api/one-piece  — real Bandai catalogue, needs APITCG_API_KEY.
  //   2. Cardmarket                 — public metadata search fallback.
  // The former `mock-onepiece` fallback was removed; if both real sources
  // fail, the search legitimately returns 0 results rather than fabricating
  // Luffy/Zoro/Law/Ace/Shanks for every query.
  return executeWithFallback([
    { name: "apitcg-onepiece",     task: () => fetchApiTcgOnePiece(query) },
    { name: "cardmarket-onepiece", task: () => fetchCardmarketOnePiece(query) },
  ]);
}

// =============================================================
// Small adapter helpers
// =============================================================

/**
 * Builds a {@link NormalizedSearchResponse} from raw card objects,
 * validating each through {@link NormalizedCardSchema}. Cards that fail
 * validation are dropped (logged) rather than crashing the whole source.
 *
 * @param source  Source label stored on the response envelope.
 * @param raw     Unvalidated card objects from the upstream API.
 */
function buildResponse(
  source: string,
  raw: unknown[]
): NormalizedSearchResponse {
  const cards: NormalizedCard[] = [];
  for (const item of raw) {
    const parsed = NormalizedCardSchema.safeParse(item);
    if (parsed.success) {
      cards.push(parsed.data);
    } else {
      console.warn(
        `[CardService] Dropping invalid card from "${source}":`,
        parsed.error.issues[0]?.message
      );
    }
  }

  // A source that responded with no usable cards should NOT short-circuit
  // the fallback chain — throw so executeWithFallback advances to the next
  // API. (NoResultsError is breaker-safe: it won't trip the circuit.)
  if (cards.length === 0) {
    throw new NoResultsError(
      `"${source}" returned 0 valid cards for this query`
    );
  }

  return { cards, source };
}

/**
 * Thin fetch wrapper that throws on non-2xx (so the executor treats it as a failure)
 * and returns parsed JSON as `unknown`. The caller is responsible for Zod validation.
 *
 * Accepts an optional AbortSignal so the underlying TCP connection is torn down
 * when the fallback executor's timeout fires — not just the Promise race.
 */
async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { headers: FETCH_HEADERS, signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// =============================================================
// POKÉMON ADAPTERS
// =============================================================

/**
 * TCGdex — https://api.tcgdex.net/v2/en/cards?name=...
 *
 * Query syntax NOTE: the v2 list endpoint uses `?name=<term>` (equals),
 * NOT `?name:<term>`. The colon form silently returns `[]`. The list view
 * does not include `rarity`/`hp`/`types` — those only appear on the
 * per-card detail endpoint — so we default them and rely on `image`.
 *
 * The `image` field is the only reliable URL source; the asset path
 * (`en/<category>/<set>/<localId>`) is NOT derivable from the card `id`
 * alone, so cards without an explicit `image` are dropped by Zod.
 */
async function fetchTcgdex(query: string): Promise<NormalizedSearchResponse> {
  const url = `https://api.tcgdex.net/v2/en/cards?name=${encodeURIComponent(
    query
  )}`;
  const payload = (await fetchJson(url)) as
    | TcgdexCard[]
    | { data: TcgdexCard[] };

  const list = Array.isArray(payload) ? payload : payload?.data ?? [];

  // TCGdex list endpoint returns a minimal shape: id, localId, name, image.
  // `image` is a base URL like "https://assets.tcgdex.net/en/base/basep/1".
  // Appending "/high.webp" constructs the canonical card-art URL.
  // Cards that have NO `image` field at all are silently skipped — they have
  // no artwork yet in the TCGdex catalog and would fail Zod's url() check.
  const cards = list
    .filter((c) => !!c.image) // drop imageless entries before Zod validation
    .map((c) => ({
      id: c.id ?? "",
      name: c.name ?? query,
      // The list endpoint does not include set/rarity/hp/types — those only
      // exist on the per-card detail endpoint. We store the base image path
      // in setImage so callers can derive the set from the URL if needed.
      setImage: c.set?.name ?? c.set?.id ?? "",
      rarity: c.rarity ?? "Unknown",
      hp: c.hp != null ? String(c.hp) : null,
      types: c.types ?? [],
      // Construct the full artwork URL from the base path.
      imageUrl: `${c.image}/high.webp`,
    }));

  return buildResponse("tcgdex", cards);
}

interface TcgdexCard {
  id?: string;
  name?: string;
  localId?: string;
  image?: string;
  rarity?: string;
  hp?: number | string;
  types?: string[];
  set?: { id?: string; name?: string };
}

/**
 * Pokémon TCG API — https://api.pokemontcg.io/v2/cards?q=name:...
 * Requires an API key for high-volume use; works unauthenticated at low volume.
 *
 * PRICING: the same response also carries `tcgplayer.prices`, a map keyed
 * by print variant (normal / holofoil / reverseHolofoil / 1stEdition*, etc.)
 * — each with low/mid/high/market/directLow. We take the first variant's
 * `market` price present (TCGplayer's own definition of current market
 * value) as this card's `marketPrice`. Previously this data was fetched
 * but discarded entirely, which is why every card in the app showed no
 * price details.
 */
async function fetchPokemonTcg(
  query: string
): Promise<NormalizedSearchResponse> {
  const url = `https://api.pokemontcg.io/v2/cards?q=name:${encodeURIComponent(
    query
  )}`;
  const payload = (await fetchJson(url)) as PokemonTcgResponse;
  const list = payload?.data ?? [];

  const cards = list.map((c) => ({
    id: c.id ?? "",
    name: c.name ?? query,
    setImage: c.set?.name ?? c.set?.id ?? "",
    rarity: c.rarity ?? "Unknown",
    hp: c.hp != null ? String(c.hp) : null,
    types: c.types ?? [],
    imageUrl: c.images?.small ?? c.images?.large ?? "",
    marketPrice: extractTcgplayerMarketPrice(c.tcgplayer),
  }));

  return buildResponse("pokemon-tcg", cards);
}

/**
 * Picks the first `market` price found across a `tcgplayer.prices`
 * variant map. Variant keys are unpredictable (normal, holofoil,
 * reverseHolofoil, 1stEditionHolofoil, unlimitedHolofoil, ...), so we
 * just take the first one that actually has a `market` number rather
 * than guessing a single "canonical" variant name.
 */
function extractTcgplayerMarketPrice(
  tcgplayer?: PokemonTcgCard["tcgplayer"]
): number | null {
  const prices = tcgplayer?.prices;
  if (!prices) return null;
  for (const variant of Object.values(prices)) {
    if (typeof variant?.market === "number" && !Number.isNaN(variant.market)) {
      return variant.market;
    }
  }
  return null;
}

interface PokemonTcgResponse {
  data?: PokemonTcgCard[];
}
interface PokemonTcgCard {
  id?: string;
  name?: string;
  rarity?: string;
  hp?: string | number;
  types?: string[];
  images?: { small?: string; large?: string };
  set?: { id?: string; name?: string };
  tcgplayer?: {
    prices?: Record<
      string,
      { low?: number; mid?: number; high?: number; market?: number; directLow?: number }
    >;
  };
}

/**
 * Scrydex (Pokémon) — community price/metadata aggregator.
 * Endpoint shape is assumed unstable; the adapter is defensive.
 */
async function fetchScrydexPokemon(
  query: string
): Promise<NormalizedSearchResponse> {
  const url = `https://www.scrydex.com/api/cards?game=pokemon&q=${encodeURIComponent(
    query
  )}`;
  const payload = (await fetchJson(url)) as ScrydexResponse;
  const list = payload?.cards ?? payload?.data ?? [];

  const cards = list.map((c) => ({
    id: c.id ?? c.product_id ?? "",
    name: c.name ?? query,
    setImage: c.set_name ?? c.setCode ?? "",
    rarity: c.rarity ?? "Unknown",
    hp: c.hp != null ? String(c.hp) : null,
    types: c.types ?? [],
    imageUrl: c.image_url ?? c.image ?? "",
  }));

  return buildResponse("scrydex-pokemon", cards);
}

interface ScrydexResponse {
  cards?: ScrydexCard[];
  data?: ScrydexCard[];
}
interface ScrydexCard {
  id?: string;
  product_id?: string;
  name?: string;
  set_name?: string;
  setCode?: string;
  rarity?: string;
  hp?: number | string;
  types?: string[];
  image_url?: string;
  image?: string;
}

// =============================================================
// ONE PIECE ADAPTERS
// =============================================================

/**
 * apitcg.com (One Piece) — the real Bandai catalogue via TCGplayer.
 *
 * Endpoint     GET https://api.apitcg.com/api/products?tcg=one-piece&name=<query>
 * Auth         `x-api-key: <APITCG_API_KEY>` HTTP header.
 * Docs         https://apitcg.com/platform (dashboard → API Key section)
 *
 * Response shape (confirmed empirically against the live endpoint):
 *   {
 *     success: true,
 *     data: [{
 *       _id: 5876,                                 // numeric internal id
 *       type: "card" | "sealed",                   // filter to "card"
 *       name: "Ace & Sabo & Luffy",
 *       code: "OP13-007",                          // Bandai card code
 *       set: { _id, name: "Carrying On His Will", code: "OP13", … },
 *       images: [{ small, medium, large }],
 *       markets: {
 *         tcgplayer: {
 *           id: "657260",
 *           url: "…",
 *           prices: { low, mid, high, market }     // real USD prices
 *         }
 *       },
 *       attributes: {
 *         Rarity: "SR" | "L" | "SEC" | "R" | "UC" | "C" | "P",
 *         Color: "Red" | "Blue" | …,
 *         CardType: "Character" | "Leader" | "Event" | "Stage",
 *         Power: "1000",                            // string, may be absent
 *         Cost: "1", Counterplus: "2000",
 *         Subtypes: "Goa Kingdom",                  // "/"-separated tags
 *         Attribute: "Strike" | "Slash" | …,
 *         Description, Artist, Number
 *       }
 *     }, …]
 *   }
 *
 * A single `products` call returns a mix of playing cards AND sealed
 * products (booster boxes, precon decks). We keep only `type === "card"`
 * so the search grid never shows a booster-box tile alongside real cards.
 *
 * Image URLs live on `tcgplayer-cdn.tcgplayer.com` which sends normal
 * CORS-permissive headers — the browser can embed them directly. The
 * legacy `/api/one-piece-img/[cardId]` proxy is no longer needed for
 * this source (it still exists for defensive rewrites of any stray
 * Bandai-hosted URL — see `rewriteOnePieceImage` below).
 */
async function fetchApiTcgOnePiece(
  query: string
): Promise<NormalizedSearchResponse> {
  const apiKey = process.env.APITCG_API_KEY;
  if (!apiKey) {
    throw new Error(
      "APITCG_API_KEY is not set — cannot query apitcg-onepiece"
    );
  }

  const url = `https://api.apitcg.com/api/products?tcg=one-piece&name=${encodeURIComponent(
    query
  )}`;
  const res = await fetch(url, {
    headers: { ...FETCH_HEADERS, "x-api-key": apiKey },
  });
  if (!res.ok) {
    throw new Error(`apitcg-onepiece HTTP ${res.status} ${res.statusText}`);
  }

  const payload = (await res.json()) as ApiTcgProductsResponse;
  if (payload?.success === false) {
    throw new Error(
      `apitcg-onepiece error: ${payload?.error ?? "unknown"}`
    );
  }
  const list = Array.isArray(payload?.data) ? payload.data : [];

  const cards = list
    // Only real playing cards — drop booster boxes, precon decks, etc.
    .filter((p) => p.type === "card")
    .map((p) => {
      const attrs = p.attributes ?? {};
      const img = p.images?.[0];
      const rawImageUrl =
        img?.large ?? img?.medium ?? img?.small ?? "";
      // Prefer the Bandai card code (e.g. "OP13-007") as our stable id so
      // upsert-by-externalId is stable across seeds. Fall back to the
      // numeric apitcg internal `_id` if code is somehow missing.
      const id = p.code ?? (p._id != null ? String(p._id) : "");
      return {
        id,
        name: p.name ?? query,
        setImage:
          p.set?.name ??
          p.set?.code ??
          "One Piece TCG",
        rarity: attrs.Rarity ?? "Unknown",
        // Power on Character/Leader cards, absent on Events/Stages.
        // We surface it as `hp` since our schema doesn't have a dedicated
        // Power field and the UI treats hp/power as interchangeable.
        hp: attrs.Power ?? null,
        types: parseOnePieceAttrs(attrs),
        imageUrl: rewriteOnePieceImage(id, rawImageUrl),
        // Real TCGplayer market price — no fabrication.
        marketPrice: p.markets?.tcgplayer?.prices?.market ?? null,
      };
    })
    // Drop cards without a usable id or image — Zod would drop them
    // anyway, but this keeps the "dropped invalid card" log clean.
    .filter((c) => c.id && c.imageUrl);

  return buildResponse("apitcg-onepiece", cards);
}

interface ApiTcgProductsResponse {
  success?: boolean;
  error?: string;
  data?: ApiTcgProduct[];
}
interface ApiTcgProduct {
  _id?: number;
  type?: "card" | "sealed" | string;
  name?: string;
  code?: string;
  set?: { _id?: string; name?: string; code?: string };
  images?: Array<{ small?: string; medium?: string; large?: string }>;
  markets?: {
    tcgplayer?: {
      prices?: {
        low?: number;
        mid?: number;
        high?: number;
        market?: number;
      };
    };
  };
  attributes?: {
    Rarity?: string;
    Color?: string;
    CardType?: string;
    Cost?: string;
    Power?: string;
    Counterplus?: string;
    Subtypes?: string;
    Attribute?: string;
    Artist?: string;
    Number?: string;
    Description?: string;
  };
}

/**
 * Turns apitcg's `attributes.*` tags into a single flat `types` array.
 * `Subtypes` is a "/"-separated multi-tag string (families like "Straw
 * Hat Crew/Supernovas"). `CardType`, `Color`, `Attribute` are single
 * values. All are collapsed into one Set for the normalized card shape.
 */
function parseOnePieceAttrs(
  attrs: NonNullable<ApiTcgProduct["attributes"]>
): string[] {
  const out = new Set<string>();
  if (attrs.CardType) out.add(attrs.CardType);
  if (attrs.Color) out.add(attrs.Color);
  if (attrs.Attribute) out.add(attrs.Attribute);
  if (attrs.Subtypes) {
    for (const tag of attrs.Subtypes.split(/[/,]/)) {
      const trimmed = tag.trim();
      if (trimmed) out.add(trimmed);
    }
  }
  return Array.from(out);
}

/**
 * Safety net: if any upstream response somehow returns a Bandai-hosted
 * card URL (`en.onepiece-cardgame.com`, which sends
 * `Cross-Origin-Resource-Policy: same-site`), rewrite it to flow
 * through our same-origin proxy at `/api/one-piece-img/[cardId]`.
 * TCGplayer CDN URLs from apitcg pass through unchanged.
 */
function rewriteOnePieceImage(cardId: string, rawUrl: string): string {
  if (!rawUrl) return "";
  if (rawUrl.startsWith("/api/one-piece-img/")) return rawUrl;
  if (
    /onepiece-cardgame\.com/i.test(rawUrl) &&
    /^(OP|ST|EB|PRB)\d{0,2}-\d{3}$/.test(cardId)
  ) {
    return `/api/one-piece-img/${cardId}`;
  }
  return rawUrl;
}

/**
 * Cardmarket API (One Piece) — Fallback 1 metadata search.
 */
async function fetchCardmarketOnePiece(
  query: string
): Promise<NormalizedSearchResponse> {
  const url = `https://api.cardmarket.com/ws/v2.0/output.json/products/find?search=${encodeURIComponent(
    query
  )}&idGame=15`;
  const payload = (await fetchJson(url)) as {
    product?: Array<{
      idProduct?: number;
      enName?: string;
      categoryName?: string;
      image?: string;
    }>;
  };

  const list = payload?.product ?? [];
  const cards = list.map((c) => ({
    id: String(c.idProduct ?? ""),
    name: c.enName ?? query,
    setImage: c.categoryName ?? "One Piece Card Game",
    rarity: "Unknown",
    hp: null,
    types: [],
    imageUrl: c.image ? `https:${c.image}` : "",
  }));

  return buildResponse("cardmarket-onepiece", cards);
}

// The One Piece mock adapter and MOCK_ONEPIECE_CARDS constant were
// removed per client feedback ("we do not want fake data"). Real data
// now flows exclusively through fetchApiTcgOnePiece + Cardmarket
// fallback. The same-origin Bandai image proxy at
// /api/one-piece-img/[cardId] still exists — it's referenced by
// rewriteOnePieceImage() above for the rare case an upstream returns a
// Bandai-hosted URL that the browser would otherwise block by CORP.

// =============================================================
// Re-exports for the route layer
// =============================================================

// The route imports the canonical response type from the validator,
// but services can also share it directly when convenient.
export type { NormalizedSearchResponse, NormalizedCard };
