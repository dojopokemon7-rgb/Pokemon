/**
 * FX service (SERVER-ONLY) — current-price display conversion.
 *
 * SCOPE (plan §2): converts a CURRENT price from its source-native currency to
 * the user's profile display currency (USD/EUR). It is NEVER applied to chart
 * history points — those stay source-native. Preserves the original amount +
 * currency at the call site (the caller stores both; this only computes the
 * display value).
 *
 * PROVIDER: a free, keyless daily-rate endpoint (exchangerate.host open ECB
 * reference feed). Documented here per plan §2:
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
// exchangerate.host is keyless; the URL is a server-side constant. If a key is
// ever required, read it from env (never hardcode a secret).
const FX_ENDPOINT = `https://api.exchangerate.host/latest?base=${FX_BASE}`;

// Zod at the boundary (AGENTS.md §5.4) — validate both the live payload and
// anything we read back out of Redis.
const RatesPayloadSchema = z.object({
  base: z.string().optional(),
  rates: z.record(z.string(), z.number()),
});
type RatesPayload = z.infer<typeof RatesPayloadSchema>;

async function readCachedRates(base: string): Promise<Record<string, number> | null> {
  try {
    const raw = await redis.get(RedisKeys.fxRates(base));
    if (!raw) return null;
    const parsed = RatesPayloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.rates : null;
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

async function fetchLiveRates(base: string): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(FX_ENDPOINT, {
      // Daily data; let the platform cache the response edge-side too.
      next: { revalidate: FX_TTL_SECONDS },
    });
    if (!res.ok) return null;
    const parsed = RatesPayloadSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    await writeCachedRates(base, parsed.data);
    return parsed.data.rates;
  } catch {
    return null;
  }
}

/**
 * Resolve the USD-based daily rate table: cache → live → null. A null result
 * means conversion is unavailable (the caller shows source-native).
 */
async function getRates(): Promise<Record<string, number> | null> {
  const cached = await readCachedRates(FX_BASE);
  if (cached) return cached;
  return fetchLiveRates(FX_BASE);
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
  const rates = await getRates();
  return convertWithRates(amount, f, to, FX_BASE, rates);
}

export type { ConvertedAmount, DisplayCurrency };
