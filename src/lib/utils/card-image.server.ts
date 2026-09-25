/**
 * Server-only clean-image resolver for One Piece cards.
 *
 * Separate from card-image.ts (which is pure, client-safe URL math) because
 * this performs outbound fetches and reads secrets — it must never be bundled
 * into the browser. Used by scripts/backfill-images.ts and the daily cron
 * sync to resolve a genuinely CLEAN (non-"SAMPLE") image URL to STORE as
 * Card.imageUrl.
 *
 * Fallback chain, best first — returns the first clean URL found, or null:
 *   1. TCG Collector API   (PRIMARY, gated by TCGCOLLECTOR_API_KEY)
 *   2. Cardmarket product image (FALLBACK 1)
 *   3. null → caller keeps whatever it had (a watermarked CDN URL is still an
 *      image; we never blank a card out, and we never fabricate a URL).
 *
 * WHY THIS EXISTS / WHY IT MAY RETURN null TODAY:
 *   Bandai stamps "SAMPLE" on every publicly distributed One Piece scan, so
 *   the free CDNs (Bandai, TCGplayer-via-apitcg, Limitless) are all
 *   watermarked. A clean scan requires a licensed source. With no
 *   TCGCOLLECTOR_API_KEY configured, step 1 is skipped and step 2 is
 *   best-effort; the resolver then returns null and the watermarked image is
 *   retained. Add the key and clean URLs flow with zero code changes.
 */

const TIMEOUT_MS = 10_000;

/** Fetch with a hard timeout; returns Response or null on any failure. */
async function safeFetch(url: string, headers?: HeadersInit): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * PRIMARY — TCG Collector card image, keyed by the Bandai card code.
 *
 * The public base + auth scheme are configurable so this works the moment a
 * key is provisioned without another code change:
 *   TCGCOLLECTOR_API_KEY   — bearer token (required to enable this source)
 *   TCGCOLLECTOR_API_BASE  — optional, defaults to the documented host
 *
 * Returns the clean image URL from the matched card, or null.
 */
async function fromTcgCollector(code: string): Promise<string | null> {
  const key = process.env.TCGCOLLECTOR_API_KEY;
  if (!key) return null; // source disabled until a licensed key is configured

  const base = process.env.TCGCOLLECTOR_API_BASE ?? "https://www.tcgcollector.com/api/v1";
  const url = `${base}/cards?cardSearch=${encodeURIComponent(code)}&tcg=one-piece`;
  const res = await safeFetch(url, {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  });
  if (!res) return null;

  try {
    const json = (await res.json()) as {
      // Defensive: accept either { cards: [...] } or { data: [...] } and the
      // common image field names — the exact shape is finalised against the
      // live key, and any miss simply falls through to null.
      cards?: TcgcCard[];
      data?: TcgcCard[];
    };
    const list = json.cards ?? json.data ?? [];
    const match =
      list.find((c) => (c.cardNumber ?? c.number ?? "").toUpperCase() === code) ?? list[0];
    const img = match?.imageUrl ?? match?.image ?? match?.images?.large ?? match?.images?.small;
    return typeof img === "string" && img.length > 0 ? img : null;
  } catch {
    return null;
  }
}

interface TcgcCard {
  cardNumber?: string;
  number?: string;
  imageUrl?: string;
  image?: string;
  images?: { small?: string; large?: string };
}

/**
 * FALLBACK 1 — Cardmarket product image.
 *
 * Cardmarket's marketplace API needs OAuth1 app credentials (idGame=15 for
 * One Piece). When CARDMARKET_APP_TOKEN is present we look up the product and
 * return its image; otherwise this is a no-op returning null. Kept behind a
 * credential check for the same reason as TCG Collector — no fabrication.
 */
async function fromCardmarket(code: string): Promise<string | null> {
  const token = process.env.CARDMARKET_APP_TOKEN;
  if (!token) return null;

  const url = `https://api.cardmarket.com/ws/v2.0/output.json/products/find?search=${encodeURIComponent(
    code
  )}&idGame=15`;
  const res = await safeFetch(url, { Authorization: token, Accept: "application/json" });
  if (!res) return null;

  try {
    const json = (await res.json()) as { product?: Array<{ image?: string }> };
    const img = json.product?.[0]?.image;
    // Cardmarket returns protocol-relative URLs ("//static.cardmarket…").
    return img ? (img.startsWith("http") ? img : `https:${img}`) : null;
  } catch {
    return null;
  }
}

/**
 * Resolves a clean, non-watermarked image URL for a One Piece card code,
 * trying the licensed sources in order. Returns null when none is available
 * (no key / no match / all failed) — callers then keep their existing image.
 * Never throws.
 */
export async function resolveOnePieceCleanImage(code: string): Promise<string | null> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;
  return (await fromTcgCollector(normalized)) ?? (await fromCardmarket(normalized));
}
