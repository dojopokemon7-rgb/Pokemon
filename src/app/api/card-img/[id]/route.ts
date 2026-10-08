/**
 * GET /api/card-img/<id>[?hi=1]
 *
 * ID-BASED, same-origin, SSRF-safe, edge-cached proxy for POKÉMON card art —
 * the twin of /api/one-piece-img/<code> for Pokémon.
 *
 * Why this exists (hide-img-source):
 *   The `?u=<url>` sibling (../route.ts) leaks the upstream CDN host in the
 *   query string — `?u=https://images.scrydex.com/...` is visible in the
 *   browser Network tab and anywhere the URL is logged. This route takes only
 *   a card id in the path, resolves the stored upstream URL SERVER-SIDE, and
 *   streams the bytes back, so the browser never sees `images.scrydex.com`.
 *
 *   `<id>` is the catalog externalId (AGENTS.md rule 3 — e.g. `base1-4`), the
 *   same segment /api/cards/[id]/* already resolves. We prefer `externalId`
 *   and fall back to the internal cuid `id` so either identifier the UI holds
 *   works. On any miss (no card, no stored URL) we 404 and the client's
 *   CardImage falls through to its remaining candidates (graceful degradation).
 *
 * Security — DB-sourced is NOT trusted:
 *   Even though the URL comes from our own `Card.imageUrl`, we re-run the SAME
 *   allowlist/https/no-credential check the `?u=` route uses
 *   (assertAllowedPokemonImageHost — the shared validator), so a poisoned or
 *   legacy stored URL can never turn this into an open proxy / internal-target
 *   SSRF. Redirects are not followed (`redirect: "manual"`) and only `image/*`
 *   content is ever streamed.
 */

import { type NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { assertAllowedPokemonImageHost } from "../ssrf";

function bad(message: string, status: 400 | 404 | 502) {
  const title =
    status === 400 ? "Bad Request" : status === 404 ? "Not Found" : "Bad Gateway";
  return NextResponse.json({ error: title, message }, { status });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  if (!id) return bad("Missing card id.", 400);

  // `?hi=1` requests the hi-res variant (imageUrlHi), falling back to the
  // medium imageUrl when no hi-res is stored. Default = medium.
  const wantHi = request.nextUrl.searchParams.get("hi") === "1";

  let card: { imageUrl: string | null; imageUrlHi: string | null } | null = null;
  try {
    // Resolve by catalog externalId first (AGENTS.md rule 3), then by the
    // internal cuid as a fallback — the UI may hold either.
    card =
      (await prisma.card.findUnique({
        where: { externalId: id },
        select: { imageUrl: true, imageUrlHi: true },
      })) ??
      (await prisma.card.findUnique({
        where: { id },
        select: { imageUrl: true, imageUrlHi: true },
      }));
  } catch (err) {
    console.error(
      `[api/card-img/${id}] Card lookup failed:`,
      err instanceof Error ? err.message : err
    );
    return bad("Card image not available.", 404);
  }

  if (!card) return bad("Card image not available.", 404);

  const stored = wantHi ? card.imageUrlHi ?? card.imageUrl : card.imageUrl;
  if (!stored) return bad("Card image not available.", 404);

  // Defense in depth: the URL came from our DB, but we STILL enforce the
  // https-only, no-credentials, exact-host allowlist (shared with the `?u=`
  // route) so a poisoned/legacy stored URL can't become an SSRF vector.
  const parsed = assertAllowedPokemonImageHost(stored);
  if (!parsed) return bad("Image host not allowed.", 400);

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
      `[api/card-img/${id}] Upstream fetch failed:`,
      err instanceof Error ? err.message : err
    );
    return bad("Could not load card image.", 502);
  }
}
