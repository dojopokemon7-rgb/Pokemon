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

/**
 * Searches eBay Browse API for listings matching `query`, returning the
 * top `limit` results normalised for our UI.
 *
 * Route callers should wrap this in Redis-backed caching (see
 * `src/app/api/ebay/search/route.ts`) — this function itself is cache-
 * agnostic so callers stay in control of TTLs and cache keys.
 *
 * @param query Free-text search term (typically a card name).
 * @param limit Number of results to return, capped by the eBay endpoint.
 * @returns Normalised listing array; empty when eBay had no matches.
 *
 * @throws {Error} on eBay HTTP errors (including 429 rate limits). The
 *   route handler translates these into the graceful fallback JSON.
 */
export async function searchEbayListings(
  query: string,
  limit: number = 3
): Promise<NormalizedEbayListing[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const token = await getEbayAccessToken();
  const baseUrl = process.env.EBAY_API_URL ?? DEFAULT_BASE_URL;

  const url =
    `${baseUrl}/buy/browse/v1/item_summary/search?` +
    `q=${encodeURIComponent(trimmed)}&limit=${limit}`;

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
