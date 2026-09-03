/**
 * eBay Browse API Service — Price Comparison & Deal Finder
 *
 * Wraps two eBay endpoints behind a small, typed surface:
 *
 *   1. OAuth2 Client Credentials token exchange
 *      POST {EBAY_API_URL}/identity/v1/oauth2/token
 *      Cached in Redis under `ebay:app-token` for 7000s (safe margin
 *      under eBay's 7200s expiry) so we don't burn a token roundtrip
 *      on every search request.
 *
 *   2. Item summary search
 *      GET  {EBAY_API_URL}/buy/browse/v1/item_summary/search?q=…&limit=3
 *      Normalised to `NormalizedEbayListing[]` — the callable route
 *      returns exactly this shape after Redis caching (see
 *      `src/app/api/ebay/search/route.ts`).
 *
 * All external errors (network failure, non-2xx, malformed JSON) are
 * surfaced as thrown `Error`s so the route handler can catch and emit
 * `{ error, fallback: true }` per the client's error-handling spec.
 *
 * @module ebay.service
 */

import { redis, RedisKeys } from "@/lib/redis";

// =============================================================
// Public types
// =============================================================

/**
 * Normalised eBay listing shape returned to the UI. Only the fields we
 * actually render (title / price / thumbnail / detail link) are kept —
 * everything else is dropped to shrink the response and avoid coupling
 * consumers to eBay's larger raw shape.
 */
export interface NormalizedEbayListing {
  /** eBay's stable item identifier (`v1|…`). */
  itemId: string;
  /** Listing title as shown on eBay. */
  title: string;
  /** Price parsed to a float in the listing's currency (see `currency`). */
  price: number;
  /** ISO 4217 currency code (`USD`, `GBP`, …). Null if eBay omitted it. */
  currency: string | null;
  /** Thumbnail URL, or null if the listing had no image. */
  imageUrl: string | null;
  /** Deep-link into the eBay listing detail page (opens in new tab). */
  itemWebUrl: string;
}

// =============================================================
// Config
// =============================================================

/** Fallback if `EBAY_API_URL` is missing — sandbox host. */
const DEFAULT_BASE_URL = "https://api.sandbox.ebay.com";

/**
 * Default OAuth scope for the Browse API.
 * The `buy.browse` endpoint accepts the plain `api_scope` grant.
 */
const OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope";

/**
 * TTL for the cached Application Access Token in seconds.
 * eBay expires them at 7200s — we cache 200s short of that to guarantee
 * we never return a token that expires mid-request.
 */
const TOKEN_CACHE_SECONDS = 7000;

// =============================================================
// Token management
// =============================================================

interface EbayTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

/**
 * Fetches an Application Access Token, using Redis as a cache to
 * avoid a fresh token roundtrip on every user request.
 *
 * Flow:
 *   1. Check Redis (`ebay:app-token`) — hit → return cached string.
 *   2. Miss → POST to eBay's `/identity/v1/oauth2/token` with
 *      `grant_type=client_credentials` and Basic auth.
 *   3. Store the returned token in Redis for 7000s.
 *
 * @throws {Error} if the env vars are missing or eBay rejects the credentials.
 */
export async function getEbayAccessToken(): Promise<string> {
  // ------------------------------------------------------------
  // 1. Cache lookup (best-effort — a Redis failure must not block
  //    the token exchange, just log and fall through).
  // ------------------------------------------------------------
  try {
    const cached = await redis.get(RedisKeys.ebayAppToken);
    if (cached) {
      return cached;
    }
  } catch (err) {
    console.warn(
      "[eBay] Redis token cache read failed, will fetch fresh:",
      err instanceof Error ? err.message : err
    );
  }

  // ------------------------------------------------------------
  // 2. Live token exchange
  // ------------------------------------------------------------
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "eBay credentials missing — set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env"
    );
  }
  const baseUrl = process.env.EBAY_API_URL ?? DEFAULT_BASE_URL;

  // Basic-auth header per RFC 6749 §2.3.1: base64(client_id:client_secret)
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64"
  );

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: OAUTH_SCOPE,
  });

  const res = await fetch(`${baseUrl}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(
      `eBay token exchange failed: HTTP ${res.status} ${res.statusText}${
        bodyText ? ` — ${bodyText.slice(0, 300)}` : ""
      }`
    );
  }

  const payload = (await res.json()) as EbayTokenResponse;
  if (!payload.access_token) {
    throw new Error("eBay token response missing `access_token`");
  }

  // ------------------------------------------------------------
  // 3. Cache write (best-effort; a Redis outage doesn't invalidate
  //    the just-obtained token — we return it either way).
  // ------------------------------------------------------------
  try {
    await redis.set(
      RedisKeys.ebayAppToken,
      payload.access_token,
      "EX",
      TOKEN_CACHE_SECONDS
    );
  } catch (err) {
    console.warn(
      "[eBay] Redis token cache write failed (non-fatal):",
      err instanceof Error ? err.message : err
    );
  }

  return payload.access_token;
}

// =============================================================
// Search
// =============================================================

/**
 * Subset of the eBay Browse API's `itemSummary` shape that we consume.
 * Every field is optional because eBay omits pieces on many listings
 * (no image, no thumbnail, no localised price, etc.).
 */
interface EbayItemSummary {
  itemId?: string;
  title?: string;
  price?: { value?: string; currency?: string };
  image?: { imageUrl?: string };
  thumbnailImages?: Array<{ imageUrl?: string }>;
  itemWebUrl?: string;
}

interface EbaySearchResponse {
  itemSummaries?: EbayItemSummary[];
  total?: number;
  errors?: Array<{ errorId?: number; message?: string }>;
}

export type EbayGame = "pokemon" | "onepiece";

export interface EbaySearchParams {
  /** Card name — becomes the primary quoted phrase. Required. */
  name: string;
  /** Set / expansion name — appended as a quoted phrase if present. */
  set?: string;
  /** Printed card number (e.g. "001/165", "OP01-001"). Quoted phrase. */
  number?: string;
  /** Which category filter to apply. */
  game: EbayGame;
}

/**
 * eBay category IDs used to filter the search to "actual trading cards"
 * (as opposed to plushies, video games, sealed boxes, etc.).
 *
 * - 183454 → Pokémon Trading Card Game (Individual Cards)
 * - 261186 → Trading Card Games (One Piece parent category)
 *
 * If eBay reorganises these categories we'll need to revisit — the API
 * silently returns zero results for a stale category rather than
 * erroring, so drift is invisible without spot-checking.
 */
const CATEGORY_IDS: Record<EbayGame, string> = {
  pokemon: "183454",
  onepiece: "261186",
};

/**
 * Builds the eBay `q` parameter using exact-phrase quoting so we match
 * this exact card rather than every listing that mentions the character
 * anywhere in the title. eBay honours double-quoted tokens in `q` as
 * required phrases.
 *
 * Examples:
 *   { name: "Charizard", set: "Base Set", number: "4/102" }
 *     → q="Charizard" "Base Set" "4/102"
 *   { name: "Monkey D. Luffy", number: "OP01-001" }
 *     → q="Monkey D. Luffy" "OP01-001"
 *
 * Empty/whitespace-only optional fields are skipped so we don't emit
 * `""` bare quotes (which eBay treats as a literal match on nothing).
 */
export function buildEbayQuery(params: EbaySearchParams): string {
  const parts: string[] = [];
  const push = (v: string | undefined) => {
    const t = v?.trim();
    if (t) parts.push(`"${t}"`);
  };
  push(params.name);
  push(params.set);
  push(params.number);
  return parts.join(" ");
}

/**
 * Searches eBay Browse API for a specific trading card using exact
 * phrase matching + a trading-card category filter.
 *
 * Route callers should wrap this in Redis-backed caching (see
 * `src/app/api/ebay/search/route.ts`) — this function itself is cache-
 * agnostic so callers stay in control of TTLs and cache keys.
 *
 * @param params Card identifiers (name is required; set/number optional).
 * @param limit  Number of results to return, capped by the eBay endpoint.
 * @returns Normalised listing array; empty when eBay had no matches.
 *
 * @throws {Error} on eBay HTTP errors (including 429 rate limits). The
 *   route handler translates these into the graceful fallback JSON.
 */
export async function searchEbayListings(
  params: EbaySearchParams,
  limit: number = 3
): Promise<NormalizedEbayListing[]> {
  const query = buildEbayQuery(params);
  if (!query) return [];

  const token = await getEbayAccessToken();
  const baseUrl = process.env.EBAY_API_URL ?? DEFAULT_BASE_URL;

  // Category IDs are strictly required by the client spec:
  //   - Pokémon TCG (Individual Cards): 183454
  //   - Trading Card Games / One Piece: 261186
  // These exclude plushies, video games, sealed products, and other
  // non-card noise that would otherwise drag the eBay average price
  // toward meaningless values.
  const categoryId = CATEGORY_IDS[params.game];

  // `filter=buyingOptions:{FIXED_PRICE|AUCTION}` skips classified-ad
  // listings (which have no price and would break the numeric average).
  const url =
    `${baseUrl}/buy/browse/v1/item_summary/search?` +
    `q=${encodeURIComponent(query)}` +
    `&category_ids=${categoryId}` +
    `&filter=${encodeURIComponent("buyingOptions:{FIXED_PRICE|AUCTION}")}` +
    `&limit=${limit}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      // Location-scoped marketplace ID. `EBAY_US` is the default; the
      // Browse API returns an unhelpful 400 without it in some regions.
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      Accept: "application/json",
    },
  });

  // Explicit 429 handling so the caller can log it separately — eBay
  // rate limits are per-app-per-day and we want them very visible.
  if (res.status === 429) {
    throw new Error("eBay rate limit hit (HTTP 429)");
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(
      `eBay Browse API failed: HTTP ${res.status} ${res.statusText}${
        bodyText ? ` — ${bodyText.slice(0, 300)}` : ""
      }`
    );
  }

  const payload = (await res.json()) as EbaySearchResponse;
  const summaries = payload.itemSummaries ?? [];

  return summaries
    .map(normaliseItem)
    // Drop listings without the minimum viable fields (id + title + link).
    .filter((l): l is NormalizedEbayListing => l !== null);
}

/**
 * Turns one raw eBay item summary into our normalised shape, or `null`
 * if the summary is too incomplete to render (missing id, title, or
 * detail URL). This is stricter than "everything optional" because the
 * UI treats these three fields as required for a clickable listing card.
 */
function normaliseItem(item: EbayItemSummary): NormalizedEbayListing | null {
  const itemId = item.itemId;
  const title = item.title;
  const itemWebUrl = item.itemWebUrl;
  if (!itemId || !title || !itemWebUrl) return null;

  // eBay returns `price.value` as a decimal STRING (e.g. `"149.99"`);
  // parseFloat drops trailing/leading whitespace and hands us NaN when
  // the value is missing — turn that into null so callers don't render
  // "NaN" as a price on the card.
  const rawValue = item.price?.value;
  const parsed = rawValue != null ? Number.parseFloat(rawValue) : NaN;
  const price = Number.isFinite(parsed) ? parsed : NaN;

  const imageUrl =
    item.image?.imageUrl ??
    item.thumbnailImages?.[0]?.imageUrl ??
    null;

  return {
    itemId,
    title,
    price: Number.isFinite(price) ? price : 0,
    currency: item.price?.currency ?? null,
    imageUrl,
    itemWebUrl,
  };
}
