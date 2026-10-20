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
 *   BUG 3 — composite-safe, EXACT-then-insensitive externalId resolve. The id
 *   arrives URL-encoded (a composite per-printing id like
 *   `gym1-1::unlimitedHolofoil` is `gym1-1%3A%3AunlimitedHolofoil`) and may be
 *   mis-cased (shared/typed link → `GYM1-1::unlimitedHolofoil`). We
 *   decodeURIComponent it, then look up externalId EXACTLY first and only fall
 *   back to a case-INSENSITIVE match. `Card.externalId` is a case-SENSITIVE
 *   @unique column, so case-only duplicate rows are possible; exact-first means
 *   a correctly-cased request always gets its own row and the insensitive
 *   fallback can never hand it a different case-fold sibling (it only rescues a
 *   mis-cased id). We do NOT strip the `::printing` suffix — a composite
 *   externalId is its OWN distinct Card row with its OWN image (AGENTS.md rule 3
 *   per-printing model), so looking up the whole composite id returns that
 *   printing's art, not the base card's. A miss returns 404 WITHOUT a
 *   Cache-Control header (see below) so a later correctly-cased lookup is never
 *   served a cached negative. A previously cached WRONG 200 is bypassed by the
 *   client-side cache-version bump (cardImgById's `?v=` — CARD_IMG_CACHE_VERSION
 *   in card-image.ts): the version changes the request URL / cache key so the
 *   corrected lookup runs instead of the week-long stale-while-revalidate entry.
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

  // BUG 3: the route segment is URL-encoded (a composite id carries `%3A%3A`).
  // Decode so the stored externalId (`gym1-1::unlimitedHolofoil`) is matched
  // literally — suffix intact, never stripped.
  let decoded: string;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    decoded = id; // malformed %-escape: fall back to the raw segment
  }

  // `?hi=1` requests the hi-res variant (imageUrlHi), falling back to the
  // medium imageUrl when no hi-res is stored. Default = medium.
  const wantHi = request.nextUrl.searchParams.get("hi") === "1";

  const imgSelect = { imageUrl: true, imageUrlHi: true } as const;
  let card: { imageUrl: string | null; imageUrlHi: string | null } | null = null;
  try {
    // Resolve by catalog externalId first (AGENTS.md rule 3). Order matters:
    //   1. EXACT externalId (`findUnique` on the @unique column). `Card.externalId`
    //      is case-SENSITIVE unique, so case-only duplicate rows are POSSIBLE
    //      (e.g. a legacy `GYM1-1::..` beside `gym1-1::..`). An exact-first hit
    //      means a correctly-cased request ALWAYS gets its own row — the
    //      insensitive fallback can never hand it a different case-fold sibling.
    //   2. CASE-INSENSITIVE externalId (`findFirst`) — only when no exact row
    //      exists, so a mis-cased shared/typed link still resolves the stored
    //      row (BUG 3). The whole decoded id (composite `::printing` suffix
    //      intact) is the key; we never strip it (per-printing model, rule 3).
    //   3. Internal cuid fallback — the UI may hold either identifier.
    card =
      (await prisma.card.findUnique({
        where: { externalId: decoded },
        select: imgSelect,
      })) ??
      (await prisma.card.findFirst({
        where: { externalId: { equals: decoded, mode: "insensitive" } },
        select: imgSelect,
      })) ??
      (await prisma.card.findUnique({
        where: { id: decoded },
        select: imgSelect,
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
