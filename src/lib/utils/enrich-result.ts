/**
 * On-view enrich result classifier (pure).
 *
 * The card-detail page fires a one-shot `POST /api/cards/[id]/enrich` on mount
 * (see src/app/(dashboard)/search/[id]/page.tsx). That route is a PUBLIC card
 * route per AGENTS.md RULE 7 — it ALWAYS returns HTTP 200 server-side — BUT the
 * client fetch can still see a transient non-200 or a thrown fetch/parse error
 * when the request never reached the handler's happy path:
 *   - 401 if the mount raced AHEAD of session-cookie hydration (the route is
 *     `requireAuth`-guarded),
 *   - 429 if the per-user credit-tier rate limit tripped,
 *   - 5xx on an infrastructure fault,
 *   - a network drop / JSON parse failure (`res.json()` throws).
 *
 * The OLD query pinned the FIRST outcome forever (staleTime+gcTime Infinity,
 * retry:false), so a card opened a beat before login stayed empty PERMANENTLY
 * even though a later manual POST enriches it fully. This helper draws the one
 * line that fix needs: did the route actually RUN (a terminal result we keep),
 * or did the attempt fail transiently (retry it)?
 *
 * TERMINAL (keep, do NOT retry) — the route genuinely ran and settled:
 *   res.ok AND the body reports one of the handler's real outcomes:
 *     - { enriched: true, ... }          (pulled + stored)
 *     - { enriched: false, reason:"fresh" }    (within the 24h window)
 *     - { enriched: false, reason:"disabled" } (ON-VIEW flag legitimately off)
 *     - { enriched: false, reason:"unknown" }  (truly-unknown card)
 *
 * TRANSIENT (retryable) — the attempt did not settle on the route:
 *   a non-OK HTTP status, OR a thrown network/parse error (callers pass
 *   ok:false for the throw path). The queryFn THROWS on transient so TanStack
 *   Query's bounded retry re-attempts; it NEVER fabricates an {enriched:false}.
 *
 * Pure + framework-free (AGENTS.md RULE 11) so page.tsx stays export-clean
 * (only its default export) and this decision is unit-testable with no network.
 */

/** The terminal `reason` values the enrich route returns alongside `ok`. */
export const TERMINAL_ENRICH_REASONS = ["fresh", "disabled", "unknown"] as const;
export type TerminalEnrichReason = (typeof TERMINAL_ENRICH_REASONS)[number];

/** The shape of the enrich response body we classify (fields optional/unknown). */
export interface EnrichResponseBody {
  enriched?: unknown;
  reason?: unknown;
}

/**
 * Inputs the classifier needs: the HTTP ok flag and the parsed JSON body.
 * On a thrown network/parse error the caller passes `{ ok: false }` with no
 * body — that lands in the TRANSIENT branch like any non-OK status.
 */
export interface EnrichClassifierInput {
  ok: boolean;
  body?: EnrichResponseBody | null;
}

/**
 * True when the enrich attempt is a real, settled result that must NOT be
 * retried (the route ran). False means a transient failure the caller should
 * THROW on so the query retries.
 */
export function isTerminalEnrichResult({ ok, body }: EnrichClassifierInput): boolean {
  // A non-OK status (401/429/5xx) or a thrown fetch/parse error (ok:false, no
  // body) is always transient — the route did not settle for this client.
  if (!ok) return false;

  const enriched = body?.enriched;
  // Route actually pulled + stored.
  if (enriched === true) return true;

  // Route legitimately declined to spend: a known settled reason.
  const reason = body?.reason;
  if (
    enriched === false &&
    typeof reason === "string" &&
    (TERMINAL_ENRICH_REASONS as readonly string[]).includes(reason)
  ) {
    return true;
  }

  // 200 but an unrecognized/malformed body (e.g. {enriched:false} with no known
  // reason). Treat as transient so a bounded retry can re-attempt rather than
  // pinning a result we cannot trust — never a fabricated success.
  return false;
}
