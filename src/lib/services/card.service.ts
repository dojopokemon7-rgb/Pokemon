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
  // One Piece chain updated: Original spec APIs were non-functional. Using TCGdex v2 + Mock fallback for MVP reliability.
  return executeWithFallback([
    { name: "tcgdex-onepiece", task: () => fetchTcgdexOnePiece(query) },
    { name: "cardmarket-onepiece", task: () => fetchCardmarketOnePiece(query) },
    { name: "mock-onepiece", task: () => fetchMockOnePiece(query) },
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
 * TCGdex v2 (One Piece) — Primary task attempt.
 */
async function fetchTcgdexOnePiece(
  query: string
): Promise<NormalizedSearchResponse> {
  const url = `https://api.tcgdex.net/v2/en/cards?name=${encodeURIComponent(
    query
  )}`;
  const payload = (await fetchJson(url)) as Array<{
    id?: string;
    name?: string;
    image?: string;
    set?: { id?: string; name?: string };
    rarity?: string;
    hp?: number | string;
    types?: string[];
  }>;

  const list = Array.isArray(payload) ? payload : [];
  const cards = list
    .filter((c) => !!c.image)
    .map((c) => ({
      id: c.id ?? "",
      name: c.name ?? query,
      setImage: c.set?.name ?? c.set?.id ?? "One Piece TCG",
      rarity: c.rarity ?? "Unknown",
      hp: c.hp != null ? String(c.hp) : null,
      types: c.types ?? [],
      imageUrl: `${c.image}/high.webp`,
    }));

  return buildResponse("tcgdex-onepiece", cards);
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

/**
 * Base URL used to build absolute image URLs for locally-bundled mock
 * assets (see MOCK_ONEPIECE_CARDS below). NormalizedCardSchema requires
 * `imageUrl` to be a full URL (z.string().url()), so a bare "/cards/..."
 * path would fail validation and get silently dropped. Mirrors the same
 * env var used for metadataBase/auth-client's baseURL elsewhere.
 */
const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

/**
 * Realistic Mock One Piece Adapter — Fallback 2 for MVP Reliability.
 * Ensures the application always resolves a valid, normalized response array.
 *
 * IMAGE URLS: these previously pointed at `assets.tcgdex.net/en/op/...`,
 * which 404s for every path — TCGdex only hosts Pokémon TCG series (base,
 * gym, neo, ex, bw, sv, tcgp, etc; confirmed via GET /v2/en/series), it
 * has never indexed One Piece card art. We point these at locally
 * bundled placeholder art in `public/cards/` instead (guaranteed to
 * resolve, since it's served by this app) rather than a broken external
 * URL — built as an absolute URL via APP_BASE_URL since the schema
 * requires a real URL, not a bare path.
 */
const MOCK_ONEPIECE_CARDS = [
  {
    id: "OP01-001",
    name: "Monkey.D.Luffy",
    setImage: "Romance Dawn (OP-01)",
    rarity: "Leader (L)",
    hp: "5000",
    types: ["Straw Hat Crew", "Supernovas"],
    imageUrl: `${APP_BASE_URL}/cards/luffy.webp`,
  },
  {
    id: "OP01-025",
    name: "Roronoa Zoro",
    setImage: "Romance Dawn (OP-01)",
    rarity: "Super Rare (SR)",
    hp: "6000",
    types: ["Straw Hat Crew"],
    imageUrl: `${APP_BASE_URL}/cards/zoro.webp`,
  },
  {
    id: "OP01-047",
    name: "Trafalgar Law",
    setImage: "Romance Dawn (OP-01)",
    rarity: "Super Rare (SR)",
    hp: "5000",
    types: ["Heart Pirates", "Supernovas"],
    imageUrl: `${APP_BASE_URL}/cards/card-front.webp`,
  },
  {
    id: "OP02-013",
    name: "Portgas.D.Ace",
    setImage: "Paramount War (OP-02)",
    rarity: "Secret Rare (SEC)",
    hp: "7000",
    types: ["Whitebeard Pirates"],
    imageUrl: `${APP_BASE_URL}/cards/card-front.webp`,
  },
  {
    id: "OP01-120",
    name: "Shanks",
    setImage: "Romance Dawn (OP-01)",
    rarity: "Secret Rare (SEC)",
    hp: "10000",
    types: ["Red-Haired Pirates"],
    imageUrl: `${APP_BASE_URL}/cards/card-front.webp`,
  },
];

async function fetchMockOnePiece(
  query: string
): Promise<NormalizedSearchResponse> {
  const q = query.toLowerCase().trim();
  const filtered = MOCK_ONEPIECE_CARDS.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.id.toLowerCase().includes(q) ||
      c.types.some((t) => t.toLowerCase().includes(q))
  );

  const list = filtered.length > 0 ? filtered : MOCK_ONEPIECE_CARDS;
  return buildResponse("mock-onepiece", list);
}

// =============================================================
// Re-exports for the route layer
// =============================================================

// The route imports the canonical response type from the validator,
// but services can also share it directly when convenient.
export type { NormalizedSearchResponse, NormalizedCard };
