/**
 * Pure FX helpers (no I/O) — unit-tested in isolation.
 *
 * Scope rule (plan §2): FX conversion applies to CURRENT-PRICE DISPLAY ONLY.
 * Chart/history points are always rendered source-native and are never passed
 * through here. Keeping the math pure means the service layer owns the network
 * (rate fetch + cache) and this stays trivially testable.
 */

export type DisplayCurrency = "USD" | "EUR";

/** A conversion result that is honest about failure (never a fabricated number). */
export interface ConvertedAmount {
  /** The amount to DISPLAY (converted when possible, else source-native). */
  amount: number;
  /** The currency `amount` is expressed in. */
  currency: string;
  /** True only when a real rate was applied (or from===to identity). */
  converted: boolean;
}

/** Apply a rate: amount in `from` → amount in `to`. Pure. */
export function applyRate(amount: number, rate: number): number {
  return amount * rate;
}

/**
 * Convert `amount` from `from` currency to `to` using a rate table keyed as
 * `rates[CODE] = units of CODE per 1 unit of base`, where `base` is the table's
 * base currency. Returns an honest ConvertedAmount:
 *   - from === to            → identity, converted:true
 *   - rate derivable         → converted value, converted:true
 *   - rate missing/invalid   → SOURCE-NATIVE amount, converted:false
 *
 * Never throws, never fabricates: an underivable rate yields the source value
 * flagged `converted:false` so the UI can show "conversion unavailable".
 */
export function convertWithRates(
  amount: number,
  from: string,
  to: DisplayCurrency,
  base: string,
  rates: Record<string, number> | null | undefined
): ConvertedAmount {
  const f = (from || "").toUpperCase();
  const t = to;
  if (!Number.isFinite(amount)) {
    return { amount, currency: f || t, converted: false };
  }
  if (f === t) {
    return { amount, currency: t, converted: true };
  }
  if (!rates) {
    return { amount, currency: f, converted: false };
  }

  const b = (base || "").toUpperCase();
  // rate(X per 1 base). To go from `f` to `t`: amount * (per_t / per_f).
  const perFrom = f === b ? 1 : rates[f];
  const perTo = t === b ? 1 : rates[t];
  if (
    typeof perFrom !== "number" ||
    typeof perTo !== "number" ||
    !Number.isFinite(perFrom) ||
    !Number.isFinite(perTo) ||
    perFrom <= 0
  ) {
    // Can't derive a real rate → stay source-native, flag unavailable.
    return { amount, currency: f, converted: false };
  }
  return { amount: applyRate(amount, perTo / perFrom), currency: t, converted: true };
}
