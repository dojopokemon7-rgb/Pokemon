/**
 * GET /api/cards/[id]/ebay-sold — real eBay SOLD records for a card, powering
 * the "Recent Sales" section on the card detail page.
 *
 * SOURCE (plan §4): Scrydex's documented sold-listings endpoint
 * `GET /{slug}/v1/cards/{scrydexId}/listings` (filtered to `source=ebay`).
 * These are REAL SOLD records (each carries `sold_at`). We NEVER fall back to
 * active listings and NEVER fabricate sales — an empty/unavailable result shows
 * "No recent sales found".
 *
 * `[id]` is the EXTERNAL card id (route param + cache key). We look up the
 * card to get its Scrydex-returned id (`scrydexId`) because the Scrydex
 * listings endpoint keys on that id, not externalId (ID mapping unverified —
 * Audit L0; we use the stored scrydexId the resolver cached).
 *
 * CREDIT: a listings call is 1 Scrydex credit, so it is OWNER-APPROVAL-GATED.
 * When live spend isn't approved (or no scrydexId is cached, or Scrydex is
 * unavailable) we return an empty list with a reason — the UI shows the empty
 * state, never active listings.
 *
 * Always 200 so the detail page renders regardless. CACHE IS REDIS ONLY
 * (RULE 1): a 24h shared per-card entry so repeat views don't re-spend the
 * credit. It is NEVER persisted to Postgres — these records are fully
 * reconstructable from Scrydex, so a Redis miss/fault just re-fetches (or
 * returns the honest empty state); nothing here is a source of truth.
 */

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { fetchScrydexSoldListings } from "@/lib/services/scrydex.service";
import { isScrydexLiveApproved } from "@/lib/services/scrydex-credit-gate";
import { redis, RedisKeys } from "@/lib/redis";

const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24h shared per-card cache

interface SoldRecord {
  itemId: string;
  source: string | null;
  title: string | null;
  price: number | null;
  currency: string | null;
  soldAt: string | null;
  grade: string | null;
  company: string | null;
  url: string | null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const sp = request.nextUrl.searchParams;
  const grade = (sp.get("grade") ?? "").trim();
  const variant = (sp.get("variant") ?? "").trim();

  const cacheKey = RedisKeys.ebaySold(["scrydex", id, grade, variant].join("|"));

  // Shared cache read (best-effort). A hit avoids re-spending the credit.
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return NextResponse.json(
        { listings: JSON.parse(cached) as SoldRecord[], source: "cache" },
        { status: 200 }
      );
    }
  } catch (err) {
    console.warn("[cards/ebay-sold] cache read failed:", err instanceof Error ? err.message : err);
  }

  // Resolve the Scrydex id (listings endpoint keys on it). No scrydexId cached
  // yet → honest empty (we don't guess the id, Audit L0).
  const card = await prisma.card.findFirst({
    where: { OR: [{ externalId: id }, { id }] },
    select: { scrydexId: true, game: true },
  });
  if (!card?.scrydexId) {
    return NextResponse.json(
      { listings: [], reason: "no-scrydex-id" },
      { status: 200 }
    );
  }

  // Credit gate — a listings call costs 1 credit; refuse unless approved.
  if (!(await isScrydexLiveApproved())) {
    return NextResponse.json(
      { listings: [], reason: "pending-approval" },
      { status: 200 }
    );
  }

  try {
    const raw = await fetchScrydexSoldListings(card.scrydexId, card.game, {
      source: "ebay",
      ...(grade ? { grade } : {}),
      ...(variant ? { variant } : {}),
      pageSize: 8,
    });
    const listings: SoldRecord[] = (raw ?? []).map((l) => ({
      itemId: l.id ?? `${l.sold_at}-${l.price}`,
      source: l.source ?? null,
      title: l.title ?? null,
      price: typeof l.price === "number" ? l.price : null,
      currency: l.currency ?? null,
      soldAt: l.sold_at ?? null,
      grade: l.grade ?? null,
      company: l.company ?? null,
      url: l.url ?? null,
    }));

    try {
      await redis.set(cacheKey, JSON.stringify(listings), "EX", CACHE_TTL_SECONDS);
    } catch (err) {
      console.warn("[cards/ebay-sold] cache write failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    return NextResponse.json({ listings, source: "live" }, { status: 200 });
  } catch (err) {
    // Scrydex down / error → graceful empty, never active listings, never crash.
    console.error("[cards/ebay-sold] scrydex listings failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ listings: [], reason: "unavailable" }, { status: 200 });
  }
}
