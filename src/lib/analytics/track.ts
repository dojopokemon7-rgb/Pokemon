/**
 * track() — the ONLY way app code sends product-analytics events (RULE 6:
 * client-safe, no server imports). Call sites never touch `posthog` directly.
 *
 * Guarantees:
 *  - SAFE NO-OP when PostHog is not initialized (no consent, no key, SSR,
 *    posthog-js still loading): `window.posthog` is only set by
 *    <AnalyticsProvider/> after consent + key + init.
 *  - NEVER throws — analytics must not break a user action.
 *  - Strips sensitive keys (email, password, otp, token) from properties. Email
 *    lives on the PERSON profile via identify(), never in event properties.
 *  - Money: any event carrying `value_usd` (real stored USD price, source of
 *    truth) also gets `currency: "USD"` and — ONLY when a real USD→INR rate
 *    exists — `value_inr`. No rate => `value_inr` is omitted entirely (never 0,
 *    never a guess; RULE 2). The rate comes from GET /api/fx/usd-inr, fetched
 *    once per session (module-level cache).
 *
 * Event names are snake_case, past tense. Shared taxonomy: docs/ANALYTICS_EVENTS.md.
 */

/** Every event the app really emits today. Backlog families are NOT listed
 *  here on purpose — add a name only when its flow ships. */
export type AnalyticsEvent =
  | "signup_started"
  | "signup_completed"
  | "onboarding_completed"
  | "login_completed"
  | "password_reset_requested"
  | "first_card_added"
  | "portfolio_viewed"
  | "card_added"
  | "card_removed"
  | "portfolio_chart_viewed"
  | "search_performed"
  | "card_viewed"
  | "filter_applied"
  | "wishlist_added"
  | "scan_started"
  | "scan_succeeded"
  | "scan_failed";

export type TrackProps = Record<string, string | number | boolean | null | undefined>;

/** The slice of the posthog-js API the app uses; set on window by AnalyticsProvider. */
export interface PostHogLike {
  capture: (event: string, props?: Record<string, unknown>) => void;
  identify?: (id: string, props?: Record<string, unknown>) => void;
  reset?: () => void;
}

declare global {
  interface Window {
    posthog?: PostHogLike;
  }
}

// Whole-token match so "access_token"/"user_email" are caught but "footprint" is not.
const SENSITIVE_KEY = /(^|[^a-z])(email|password|passwd|otp|token)([^a-z]|$)/i;

/** Drop sensitive and undefined keys. Pure. */
export function sanitizeProps(props?: TrackProps): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!props) return out;
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || SENSITIVE_KEY.test(k)) continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue; // never send NaN/Infinity
    out[k] = v;
  }
  return out;
}

// ---- USD→INR (module-level, once per page session) -------------------------
let inrRatePromise: Promise<number | null> | null = null;

async function fetchUsdInr(): Promise<number | null> {
  try {
    const res = await fetch("/api/fx/usd-inr", { credentials: "same-origin" });
    if (!res.ok) return null;
    const json = (await res.json()) as { rate?: unknown };
    return typeof json.rate === "number" && Number.isFinite(json.rate) && json.rate > 0
      ? json.rate
      : null;
  } catch {
    return null;
  }
}

function getUsdInrRate(): Promise<number | null> {
  inrRatePromise ??= fetchUsdInr();
  return inrRatePromise;
}

/** Test seam: forget the cached rate. */
export function resetUsdInrCache(): void {
  inrRatePromise = null;
}

/** Add currency (+ value_inr when a real rate exists) to money props. Pure. */
export function withMoney(
  props: Record<string, string | number | boolean | null>,
  rate: number | null
): Record<string, string | number | boolean | null> {
  const usd = props.value_usd;
  if (typeof usd !== "number" || !Number.isFinite(usd)) return props;
  const out: Record<string, string | number | boolean | null> = { ...props, currency: "USD" };
  if (rate !== null) out.value_inr = Math.round(usd * rate * 100) / 100;
  return out;
}

export function track(event: AnalyticsEvent, props?: TrackProps): void {
  try {
    if (typeof window === "undefined") return;
    const ph = window.posthog;
    if (!ph) return;
    const clean = sanitizeProps(props);
    if (typeof clean.value_usd === "number" && Number.isFinite(clean.value_usd)) {
      void getUsdInrRate().then((rate) => {
        try {
          ph.capture(event, withMoney(clean, rate));
        } catch {
          // never throw from analytics
        }
      });
    } else {
      ph.capture(event, clean);
    }
  } catch {
    // never throw from analytics
  }
}
