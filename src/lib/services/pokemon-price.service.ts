/**
 * Pokémon TCG API — current market price (F-18 real pricing source).
 *
 * The Pokémon TCG API (https://docs.pokemontcg.io) returns a card's
 * TCGplayer price block on the by-id endpoint:
 *   GET https://api.pokemontcg.io/v2/cards/{id}
 *   header: X-Api-Key: <POKEMON_TCG_API_KEY>  (optional; raises rate limits)
 *   → { data: { tcgplayer: { prices: { <variant>: { market, ... } } } } }
 *
 * IMPORTANT — current price only, NO history:
 *   The Pokémon TCG API exposes the CURRENT TCGplayer "market" price. It
 *   does NOT provide a historical price series. We therefore build history
 *   ourselves by SNAPSHOTTING this current price into PricingHistory on a
 *   schedule (see scripts/snapshot-pokemon-prices.ts) — history accumulates
 *   over time. A backfilled historical series needs a paid provider such as
 *   PriceCharting (planned follow-up), not this API.
 *
 * Every failure mode (no card, no price block, HTTP error, network/timeout,
 * bad JSON) returns `null` so callers degrade gracefully rather than crash.
 */

const POKEMON_TCG_BASE = "https://api.pokemontcg.io/v2";
const REQUEST_TIMEOUT_MS = 10_000;

export interface CurrentPrice {
  value: number;
  currency: string;
  timestamp: Date;
}

interface PokemonCardByIdResponse {
  data?: {
    id?: string;
    tcgplayer?: {
      prices?: Record<string, { market?: number | null } | undefined>;
    } | null;
  } | null;
}

function pokemonHeaders(): HeadersInit {
  const key = process.env.POKEMON_TCG_API_KEY;
  return key ? { "X-Api-Key": key } : {};
}

/**
 * Picks the first present TCGplayer `market` price across the variant map
 * (normal / holofoil / reverseHolofoil / 1stEdition* …). Variant keys are
 * unpredictable, so we scan rather than assume a canonical variant — the
 * same approach the search/sync paths already use.
 */
function pickMarketPrice(
  prices?: Record<string, { market?: number | null } | undefined>
): number | null {
  if (!prices) return null;
  for (const variant of Object.values(prices)) {
    const m = variant?.market;
    if (typeof m === "number" && Number.isFinite(m) && m > 0) return m;
  }
  return null;
}

/**
 * Fetches the current TCGplayer market price for a Pokémon card by its
 * external id (e.g. "base1-4").
 *
 * @returns `{ value, currency, timestamp }` on success, or `null` when the
 *          card/price is unavailable or the API call fails. Never throws.
 */
export async function fetchPokemonMarketPrice(externalId: string): Promise<CurrentPrice | null> {
  const id = String(externalId).trim();
  if (!id) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${POKEMON_TCG_BASE}/cards/${encodeURIComponent(id)}`, {
      headers: pokemonHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) return null; // 404 (unknown id), 429 (rate limit), 5xx → degrade

    const json = (await res.json()) as PokemonCardByIdResponse;
    const market = pickMarketPrice(json.data?.tcgplayer?.prices ?? undefined);
    if (market == null) return null;

    return { value: market, currency: "USD", timestamp: new Date() };
  } catch {
    // Network error, timeout/abort, or JSON parse failure → unavailable.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
