/**
 * FX service (SERVER-ONLY) — current-price display conversion.
 *
 * SCOPE (plan §2): converts a CURRENT price from its source-native currency to
 * the user's profile display currency (USD/EUR). It is NEVER applied to chart
 * history points — those stay source-native. Preserves the original amount +
 * currency at the call site (the caller stores both; this only computes the
 * display value).
 *
 * PROVIDER: exchangerate.host /live daily rates, which now needs an API key
 * (EXCHANGE_RATE_API_KEY; without it every conversion reports unavailable).
 * Documented here per plan §2:
 *   - Rates are cached in Redis `fx:rates:{base}` for 24h (RedisKeys.fxRates).
 *   - Redis is OPTIONAL: a cache miss or Redis outage falls through to a live
 *     fetch; the result is best-effort re-cached (failure to cache is ignored).
 *   - FAILURE BEHAVIOUR (plan §2): if no rate can be obtained, we return the
 *     SOURCE-NATIVE amount with `converted:false` so the UI shows the native
 *     value and a clear "conversion unavailable" state. We NEVER fabricate a
 *     converted number.
 *
 * The provider base is USD; EUR (and any JPY→EUR path) is derived from the USD
 * table. This matters because Scrydex currently emits USD/JPY and EUR is "in
 * development", so EUR display depends on this conversion.
 */
import { z } from "zod";
import { redis, RedisKeys } from "@/lib/redis";
import {
  convertWithRates,
  type ConvertedAmount,
  type DisplayCurrency,
} from "@/lib/utils/fx";

const FX_BASE = "USD";
const FX_TTL_SECONDS = 24 * 60 * 60;
// exchangerate.host now REQUIRES an API key (verified: the old keyless
// `/latest?base=USD` call returns HTTP 401). The key is optional here: with no
// EXCHANGE_RATE_API_KEY we make NO request and report "unavailable" (null) —
// the caller shows source-native amounts / omits INR; we never fabricate a rate
// (RULE 2). Server-side env only, never NEXT_PUBLIC_*.
// ponytail: response shape of `/live` (`quotes: { USDINR: n }`) follows the
// provider's published contract but is UNVERIFIED against a live key; Zod below
// rejects anything else, so a contract mismatch degrades to null, not bad data.
const FX_ENDPOINT = "https://api.exchangerate.host/live";

// Zod at the boundary (AGENTS.md §5.4) — validate both the live payload and
// anything we read back out of Redis. `rates[CODE]` = units of CODE per 1 USD.
const RatesPayloadSchema = z.object({
  base: z.string().optional(),
  rates: z.record(z.string(), z.number()),
  /** ISO timestamp of the provider quote (when the provider supplies one). */
  asOf: z.string().optional(),
});
type RatesPayload = z.infer<typeof RatesPayloadSchema>;

// Provider `/live` payload: `quotes` keys are `${source}${CODE}` (e.g. USDINR).
const LivePayloadSchema = z.object({
  success: z.boolean().optional(),
  timestamp: z.number().optional(),
  quotes: z.record(z.string(), z.number()),
});

async function readCachedPayload(base: string): Promise<RatesPayload | null> {
  try {
    const raw = await redis.get(RedisKeys.fxRates(base));
    if (!raw) return null;
    const parsed = RatesPayloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    // Redis down / malformed → treat as a miss (fail-open).
    return null;
  }
}

async function writeCachedRates(base: string, payload: RatesPayload): Promise<void> {
  try {
    await redis.set(
      RedisKeys.fxRates(base),
      JSON.stringify(payload),
      "EX",
      FX_TTL_SECONDS
    );
  } catch {
    // Best-effort cache; a write failure must never break a price display.
  }
}

async function fetchLivePayload(base: string): Promise<RatesPayload | null> {
  const key = process.env.EXCHANGE_RATE_API_KEY?.trim();
  if (!key) return null; // no provider key → honestly unavailable
  try {
    const url = `${FX_ENDPOINT}?access_key=${encodeURIComponent(key)}&source=${base}`;
    const res = await fetch(url, {
      // Daily data; let the platform cache the response edge-side too.
      next: { revalidate: FX_TTL_SECONDS },
    });
    if (!res.ok) return null;
    const parsed = LivePayloadSchema.safeParse(await res.json());
    if (!parsed.success || parsed.data.success === false) return null;
    const rates: Record<string, number> = {};
    for (const [pair, value] of Object.entries(parsed.data.quotes)) {
      if (pair.startsWith(base) && pair.length > base.length) {
        rates[pair.slice(base.length)] = value;
      }
    }
    if (Object.keys(rates).length === 0) return null;
    const payload: RatesPayload = {
      base,
      rates,
      asOf: parsed.data.timestamp
        ? new Date(parsed.data.timestamp * 1000).toISOString()
        : undefined,
    };
    await writeCachedRates(base, payload);
    return payload;
  } catch {
    return null;
  }
}

/**
 * Resolve the USD-based daily rate payload: cache → live → null. A null result
 * means conversion is unavailable (the caller shows source-native).
 */
async function getPayload(): Promise<RatesPayload | null> {
  return (await readCachedPayload(FX_BASE)) ?? (await fetchLivePayload(FX_BASE));
}

/**
 * Real USD→INR rate for analytics value_inr, or null when unavailable (no key /
 * provider down / INR missing). Never throws, never guesses.
 */
export async function getUsdInrRate(): Promise<{ rate: number; asOf: string | null } | null> {
  const payload = await getPayload();
  const rate = payload?.rates.INR;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  return { rate, asOf: payload?.asOf ?? null };
}
/**
 * Convert a CURRENT price for display. Returns an honest ConvertedAmount:
 * identity when from===to, a converted value when a rate exists, or the
 * source-native amount with `converted:false` when no rate is obtainable.
 *
 * Does NOT throw. Does NOT convert history points — call sites for charts must
 * not use this.
 */
export async function convertCurrentPrice(
  amount: number,
  from: string,
  to: DisplayCurrency
): Promise<ConvertedAmount> {
  const f = (from || "").toUpperCase();
  if (f === to) return { amount, currency: to, converted: true };
  const rates = (await getPayload())?.rates ?? null;
  return convertWithRates(amount, f, to, FX_BASE, rates);
}

export type { ConvertedAmount, DisplayCurrency };
