/**
 * One Piece card image resolution — the single source of truth for the
 * image fallback CHAIN, shared by the search/trending routes, the daily
 * cron sync, the backfill script, and the UI's <img onError> stepper.
 *
 * THE WATERMARK PROBLEM (verified empirically):
 *   Every *free* One Piece image source carries Bandai's "SAMPLE" watermark:
 *     - en.onepiece-cardgame.com (Bandai CDN)        → SAMPLE
 *     - tcgplayer-cdn.tcgplayer.com (relayed by apitcg) → SAMPLE
 *     - limitlesstcg / cardmarket public scans         → SAMPLE or blocked
 *   A genuinely clean scan requires a LICENSED provider. TCG Collector's API
 *   is that provider, gated behind TCGCOLLECTOR_API_KEY. When that key is
 *   present, resolveOnePieceCleanImage() (server-only, in card-image.server)
 *   fetches the clean URL and it gets stored as Card.imageUrl. When it's
 *   absent we fall back down the chain to whatever is available (watermarked),
 *   never a broken image.
 *
 * THE CHAIN (highest quality first):
 *   1. stored Card.imageUrl — once the backfill/sync has resolved a clean
 *      TCG Collector URL it lives here, so it wins.
 *   2. Cardmarket product image (if derivable) — Fallback 1.
 *   3. TCGplayer CDN hi-res (stored imageUrlHi) — Fallback 2.
 *   4. Bandai proxy /api/one-piece-img/<code> — last resort, same-origin.
 *
 * The UI renders chain[0] and, on <img onError>, advances to chain[1], [2]…
 * so a 404/blocked source at any tier automatically tries the next.
 */

// Set-coded cards (OP/ST/EB/PRB) + P-### promos — the codes Bandai's CDN hosts.
const ONE_PIECE_CODE = /^((?:OP|ST|EB|PRB)\d{2}-\d{3}|P-\d{3})$/;

/** True for a One Piece card code we can build a Bandai-proxy URL for. */
export function isOnePieceCode(externalId: string): boolean {
  return ONE_PIECE_CODE.test(externalId.trim().toUpperCase());
}

/** Bandai same-origin proxy URL, or null if the code isn't a Bandai code. */
export function onePieceImageUrl(externalId: string): string | null {
  const code = externalId.trim().toUpperCase();
  return ONE_PIECE_CODE.test(code) ? `/api/one-piece-img/${code}` : null;
}

/**
 * Ordered list of image URLs to try for a One Piece card, best first.
 * De-duplicated, empties removed. The UI steps through this on <img onError>;
 * the routes/sync emit `chain[0]` as the primary `imageUrl`.
 *
 * @param externalId card code, e.g. "OP01-001"
 * @param stored     the already-stored Card.imageUrl (may be a clean TCG
 *                   Collector URL after backfill, or a watermarked CDN URL)
 * @param storedHi   the stored hi-res URL (Card.imageUrlHi)
 */
export function onePieceImageChain(
  externalId: string,
  stored?: string | null,
  storedHi?: string | null
): string[] {
  const proxy = onePieceImageUrl(externalId);
  const isTcgPlayer = (u?: string | null) =>
    Boolean(u && u.includes("tcgplayer-cdn.tcgplayer.com"));

  // If the stored URL is from tcgplayer-cdn (which returns 403 Forbidden
  // on CloudFront) or absent, prefer our same-origin Bandai proxy first
  // so the image loads immediately without failing a blocked request.
  const preferred =
    proxy && (isTcgPlayer(stored) || !stored)
      ? [proxy, stored, storedHi]
      : [stored, storedHi, proxy];

  const chain = preferred.filter(
    (u): u is string => typeof u === "string" && u.length > 0
  );
  return Array.from(new Set(chain));
}
