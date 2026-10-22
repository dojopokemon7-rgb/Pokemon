/**
 * Pure guard for the card-detail `/api/cards/[id]/prices` payload.
 *
 * The prices route legitimately returns HTTP 200 `{ prices: [] }` during a
 * pre-resolve window (the `!card` and `catch` branches). A hover-prefetch that
 * fires during such a window would otherwise cache that empty blob into the
 * React Query client under `["card-prices", id]`, which the detail page then
 * serves as stale-but-fresh under the global 5-minute staleTime. The prefetch
 * uses this guard to SKIP caching a transient-empty payload (it throws instead,
 * so no cache entry is written) — never fabricating data, just declining to
 * pin an empty result the detail page would have to revalidate past anyway.
 */
export function isNonEmptyPricesPayload(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as { prices?: unknown }).prices) &&
    (payload as { prices: unknown[] }).prices.length > 0
  );
}
