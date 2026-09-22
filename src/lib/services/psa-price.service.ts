/**
 * PSA Public API client (F-17 graded pricing).
 *
 * Auth + endpoint per the official PSA public API docs
 * (https://www.psacard.com/publicapi/documentation):
 *   - Base URL: https://api.psacard.com/publicapi
 *   - Header:   Authorization: bearer <PSA_API_KEY>
 *   - Endpoint: GET /cert/GetByCertNumber/{certNumber}
 *
 * IMPORTANT — what the PSA *public* API does and does NOT provide:
 *   It is a CERT-VERIFICATION api: given a certificate number it returns the
 *   card's verified description + grade. It does NOT expose a price guide or
 *   population data (those fields come back null; there is no pricing
 *   endpoint on the public tier). So we cannot "fetch a price" directly.
 *
 * How F-17 uses it: when a graded card carries a PSA cert number we call the
 * real API to VERIFY the grade, then resolve the graded market value through
 * the curated graded-price table (see graded-price.ts). This keeps the value
 * grounded in a real, authenticated PSA grade while the public API's lack of
 * pricing is bridged by our own table. Every failure mode (missing key, 429
 * rate limit, network error, invalid cert) returns `null` so the caller's
 * resolver falls back to the known-good value and flags it stale/fallback.
 */

const PSA_BASE_URL = "https://api.psacard.com/publicapi";
const REQUEST_TIMEOUT_MS = 10_000;

/** Normalised subset of a PSA cert response we actually use. */
export interface PSACert {
  certNumber: number;
  grade: string;
  subject: string;
  set: string;
  year: string;
}

interface PSAApiResponse {
  PSACert: {
    CertNumber?: number;
    CardGrade?: string;
    Subject?: string;
    Variety?: string;
    YearIssued?: string;
  } | null;
  IsValidRequest?: boolean;
  ServerMessage?: string;
}

/**
 * Verifies a PSA certificate number against the live PSA public API.
 *
 * @returns the parsed cert on success, or `null` on ANY failure (no API key,
 *          HTTP 429/4xx/5xx, network/timeout, invalid or unknown cert). Never
 *          throws — graded pricing must degrade gracefully, not crash.
 */
export async function fetchPSACert(certNumber: string): Promise<PSACert | null> {
  const apiKey = process.env.PSA_API_KEY;
  // No key configured (or the placeholder) → treat as "source unavailable".
  if (!apiKey || apiKey === "your_token_here") return null;

  const cert = String(certNumber).trim();
  if (!/^\d+$/.test(cert)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${PSA_BASE_URL}/cert/GetByCertNumber/${encodeURIComponent(cert)}`, {
      headers: {
        Authorization: `bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    // 429 = rate limited, 5xx = server/credential error, etc. All → fallback.
    if (!res.ok) return null;

    const json = (await res.json()) as PSAApiResponse;
    if (!json.IsValidRequest || !json.PSACert || json.PSACert.CertNumber == null) {
      return null;
    }
    const c = json.PSACert;
    return {
      certNumber: c.CertNumber!,
      grade: String(c.CardGrade ?? ""),
      subject: c.Subject ?? "",
      set: c.Variety ?? "",
      year: c.YearIssued ?? "",
    };
  } catch {
    // Network error, timeout/abort, JSON parse failure → source unavailable.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export interface PSAGradedPriceInput {
  cardName: string;
  set: string;
  grade: string | number;
  /** Raw (ungraded) market price — the base the graded value derives from. */
  rawMarketPrice: number;
  /** Optional PSA certificate number. When present, the grade is verified
   *  against the live PSA API before a graded value is returned. */
  certNumber?: string | null;
}

/**
 * F-17 live price source for a PSA-graded card.
 *
 * Because the PSA public API has no price guide, the "live" step is grade
 * VERIFICATION: if a cert number is supplied we confirm the card's grade
 * with PSA, then resolve the graded market value from the curated table
 * (imported lazily to avoid a cycle). If no cert is supplied, or the API
 * call fails / rate-limits, we return `null` so `resolveGradedPrice` uses
 * its own fallback and flags the result stale.
 *
 * @returns a positive USD number, or `null` when the source is unavailable.
 */
export async function fetchPSAGradedPrice(input: PSAGradedPriceInput): Promise<number | null> {
  const { cardName, set, grade, rawMarketPrice, certNumber } = input;

  // Verify against the live API when we have a cert to check. A failed or
  // absent verification means we don't have an authenticated live signal.
  if (certNumber) {
    const cert = await fetchPSACert(certNumber);
    if (!cert) return null; // rate-limited / down / invalid → fall back
    // Prefer PSA's authoritative grade over the caller-provided one.
    const verifiedGrade = cert.grade || String(grade);
    const { getGradedPrice } = await import("@/lib/utils/graded-price");
    const value = getGradedPrice(cardName, set, verifiedGrade, rawMarketPrice);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  // No cert to verify → no live signal; let the resolver fall back.
  return null;
}
