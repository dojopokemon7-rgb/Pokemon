/**
 * GET /api/card-img?u=<encoded upstream image url>
 *
 * Same-origin, SSRF-safe, edge-cached proxy for POKÉMON card artwork.
 *
 * Why this exists (client code-review HIGH):
 *   Pokémon art was hot-linked straight from external CDNs
 *   (images.scrydex.com et al.) on EVERY tile render, with no caching or
 *   CDN in front. That burns the upstream's bandwidth and makes us an
 *   availability risk on traffic spikes (if the upstream throttles us, the
 *   whole grid goes blank). One Piece art already goes through its own
 *   same-origin proxy (/api/one-piece-img/<id>); this is the Pokémon twin.
 *
 *   Fetching server-side and streaming back through our origin lets the
 *   browser + Vercel edge cache the bytes (24h fresh + 1wk SWR), so a card
 *   image is pulled from the upstream once, not once per visitor.
 *
 * Security — this must NOT become an open proxy / SSRF hole:
 *   Unlike One Piece (single Bandai host, so an id pattern suffices), Pokémon
 *   art lives on several hosts, so we take a URL. Every request is validated:
 *     - `u` must be a well-formed https URL (no http, no odd schemes).
 *     - `new URL(u).hostname` must EXACTLY equal an allowlisted host
 *       (Set equality — NOT substring includes, which
 *       `images.scrydex.com.attacker.com` would bypass).
 *     - no credentials / userinfo in the URL.
 *     - redirects are NOT followed (`redirect: "manual"`), so an allowlisted
 *       host can't 302 us off-allowlist to an internal/arbitrary target.
 *     - the upstream Content-Type must be `image/*`, else we 404 — the
 *       endpoint can only ever stream images, never arbitrary content.
 *   An attacker cannot make this fetch an internal/metadata URL or act as a
 *   generic image proxy.
 */

import { type NextRequest, NextResponse } from "next/server";

// Hosts that actually serve Pokémon card art in this app (confirmed below):
//   - images.scrydex.com  — the entire stored catalog (full-catalog pull;
//     e.g. https://images.scrydex.com/pokemon/mee-1/medium). Verified by
//     querying every POKEMON Card.imageUrl: 10000/10000 are this host.
//   - assets.tcgdex.net   — TCGdex live-search fallback adapter
//     (card.service.ts fetchTcgdex → `${image}/high.webp`).
//   - images.pokemontcg.io — Pokémon TCG API live-search fallback adapter
//     (card.service.ts fetchPokemonTcg → images.small/large).
// Exact-match Set — never a substring check.
const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "images.scrydex.com",
  "assets.tcgdex.net",
  "images.pokemontcg.io",
]);

function bad(message: string, status: 400 | 404 | 502) {
  const title =
    status === 400 ? "Bad Request" : status === 404 ? "Not Found" : "Bad Gateway";
  return NextResponse.json({ error: title, message }, { status });
}

export async function GET(request: NextRequest): Promise<Response> {
  const raw = request.nextUrl.searchParams.get("u");
  if (!raw) {
    return bad("Missing image url.", 400);
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return bad("Malformed image url.", 400);
  }

  // https only, no credentials, exact allowlisted host. Reject everything else.
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !ALLOWED_HOSTS.has(parsed.hostname)
  ) {
    return bad("Image host not allowed.", 400);
  }

  try {
    const upstream = await fetch(parsed.toString(), {
      headers: { "User-Agent": "Dojo-TCG/0.1 (+card-image-proxy)" },
      // Cache at the edge — card art rarely changes.
      cache: "force-cache",
      // Do NOT follow redirects: an allowlisted host must not be able to
      // bounce us off-allowlist (SSRF). A redirect becomes a miss (404).
      redirect: "manual",
    });

    const contentType = upstream.headers.get("Content-Type") ?? "";

    // Only ever stream images — never let this proxy arbitrary content, and
    // treat a redirect / non-image body as a miss.
    if (!upstream.ok || !upstream.body || !contentType.startsWith("image/")) {
      return bad("Card image not available.", 404);
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": contentType || "image/webp",
        // Browser + CDN caching — 24h fresh, week-long stale-while-revalidate.
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
      },
    });
  } catch (err) {
    console.error(
      "[api/card-img] Upstream fetch failed:",
      err instanceof Error ? err.message : err
    );
    return bad("Could not load card image.", 502);
  }
}
