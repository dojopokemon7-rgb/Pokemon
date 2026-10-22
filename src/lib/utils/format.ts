/**
 * Shared display formatters for the admin panel.
 * Kept in one place so currency/date output stays consistent across pages.
 */

const CURRENCY_FMT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

// audit 04 F-02 (RULE 2 — don't mislabel): stored prices are SOURCE-NATIVE and
// carry their own currency (PricingHistory/CurrentPrice `currency`, default
// "USD"; One Piece / Cardmarket can be EUR). Hard-coding "$" would render a EUR
// or JPY value as USD — a false label. So formatters take an OPTIONAL currency
// code: when a caller KNOWS the row's currency it labels honestly (€, ¥, …);
// when unknown it defaults to "USD" (the stored default, the vast-majority
// case) so existing USD call sites are unchanged. FX conversion is OUT OF SCOPE
// (audit 09 F4, unwired) — we only LABEL, never convert. Formatters are cached
// per currency so the hot USD path stays allocation-free.
const CURRENCY_FMT_CACHE = new Map<string, Intl.NumberFormat>([["USD", CURRENCY_FMT]]);
function currencyFmt(currency: string): Intl.NumberFormat {
  let fmt = CURRENCY_FMT_CACHE.get(currency);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat("en-US", { style: "currency", currency });
    } catch {
      // An unknown/invalid code must not throw — fall back to the USD formatter
      // rather than crash a render (honest default, never a fabricated symbol).
      fmt = CURRENCY_FMT;
    }
    CURRENCY_FMT_CACHE.set(currency, fmt);
  }
  return fmt;
}

const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const DATE_TIME_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatCurrency(
  value: number | null | undefined,
  currency = "USD"
): string {
  if (value == null || Number.isNaN(value)) return "—";
  return currencyFmt(currency).format(value);
}

const CURRENCY_COMPACT_FMT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});
const CURRENCY_COMPACT_CACHE = new Map<string, Intl.NumberFormat>([["USD", CURRENCY_COMPACT_FMT]]);
function currencyCompactFmt(currency: string): Intl.NumberFormat {
  let fmt = CURRENCY_COMPACT_CACHE.get(currency);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        notation: "compact",
        maximumFractionDigits: 2,
      });
    } catch {
      fmt = CURRENCY_COMPACT_FMT;
    }
    CURRENCY_COMPACT_CACHE.set(currency, fmt);
  }
  return fmt;
}

/**
 * Compact currency — shared lift of the card-detail page's former
 * `fmtUSDCompact` (grade chip labels + chart Y-axis labels). Below 1000 use the
 * full formatter so small raw prices stay exact (e.g. 650 → "$650.00"); at/above
 * 1000 use Intl compact notation (e.g. 1000 → "$1K", 61580 → "$61.58K"). The
 * default-USD output MUST match the old fmtUSDCompact byte-for-byte so chip
 * labels are unchanged; a caller that knows a non-USD source currency passes it
 * so the label is honest (audit 04 F-02 — never assert "$" for a non-USD value).
 * A page.tsx may only export framework symbols, so the shared AreaChart imports
 * it from here (AGENTS.md rule 11, DRY).
 */
export function formatCurrencyCompact(n: number, currency = "USD"): string {
  if (n < 1000) return currencyFmt(currency).format(n);
  return currencyCompactFmt(currency).format(n);
}

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  return DATE_FMT.format(d);
}

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  return DATE_TIME_FMT.format(d);
}

/** e.g. "2 days ago", "5 minutes ago", "just now". */
export function formatRelative(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  const diffMs = Date.now() - d.getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}
