/**
 * GET /api/one-piece-img/<cardId>
 *
 * Same-origin proxy for One Piece card artwork hosted on
 * `en.onepiece-cardgame.com`.
 *
 * Why this exists:
 *   Bandai's One Piece Card Game CDN serves images with
 *     Cross-Origin-Resource-Policy: same-site
 *   which the browser interprets as "cannot be embedded from any other
 *   origin". A plain `<img src="https://en.onepiece-cardgame.com/...">`
 *   from our app (localhost:3000 / *.vercel.app) is blocked by CORB
 *   even though the image is publicly reachable via curl.
 *
 *   This route fetches the image server-side (no CORP check applies to
 *   server-to-server requests) and streams it back through our own
 *   origin, so the browser treats it as a same-origin asset.
 *
 * Security:
 *   - The `cardId` is strictly validated against `/^(OP|ST)\d{2}-\d{3}$/`
 *     so this endpoint can never be used as an open image proxy for
 *     arbitrary URLs.
 *   - Only the Bandai domain is contacted; no user input reaches fetch
 *     without validation.
 */

import { type NextRequest, NextResponse } from "next/server";

const CARD_ID_PATTERN = /^(OP|ST)\d{2}-\d{3}$/;
const UPSTREAM_BASE = "https://en.onepiece-cardgame.com/images/cardlist/card/";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ cardId: string }> }
): Promise<Response> {
  const { cardId } = await params;

  if (!CARD_ID_PATTERN.test(cardId)) {
    return NextResponse.json(
      { error: "Bad Request", message: "Invalid card id." },
      { status: 400 }
    );
  }

  const upstreamUrl = `${UPSTREAM_BASE}${cardId}.png`;

  try {
    const upstream = await fetch(upstreamUrl, {
      // Server-side fetch has no CORP restriction and doesn't need a
      // browser-like Referer for this endpoint (confirmed working via
      // curl with no headers). We just pass a UA out of politeness.
      headers: { "User-Agent": "Dojo-TCG/0.1 (+card-image-proxy)" },
      // Cache at the edge — cards rarely change.
      cache: "force-cache",
    });

    if (!upstream.ok || !upstream.body) {
      return NextResponse.json(
        { error: "Not Found", message: "Card image not available." },
        { status: 404 }
      );
    }

    // Stream the bytes straight through; no memory copy needed.
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "image/png",
        // Browser + CDN caching — 24h fresh, week-long stale-while-revalidate.
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
      },
    });
  } catch (err) {
    console.error(
      `[api/one-piece-img/${cardId}] Upstream fetch failed:`,
      err instanceof Error ? err.message : err
    );
    return NextResponse.json(
      { error: "Bad Gateway", message: "Could not load card image." },
      { status: 502 }
    );
  }
}
