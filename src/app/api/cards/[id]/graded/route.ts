/**
 * GET /api/cards/[id]/graded?grade=<g> — PSA graded price for one card (FR-6).
 *
 * `[id]` is the EXTERNAL card id (same convention as the sibling
 * prices/history routes). `grade` comes from the query string (default "10").
 * `game` is read from the DB Card.game — the server owns the id→game mapping
 * (NFR-3), never the query string.
 *
 * PUBLIC card route (NFR-4 / AGENTS.md §5.7): returns HTTP 200 +
 * { price: null, isFallback: true, isStale: true } + Cache-Control: no-store
 * on an unknown card, an unpriced card (marketPrice == null), or ANY thrown
 * error — NEVER 4xx/5xx. The UI renders the heuristic fallback / "—".
 *
 * FRESHNESS / CREDIT POLICY (MEDIUM-1): this route obeys the SAME freshness
 * gate + SyncLog metering + Card.scrydexId write-back as every other Scrydex
 * caller by routing the Scrydex fetch through pullAndStoreScrydexPrice(card,
 * { force: false }). A repeat public view within SCRYDEX_STALE_MS short-
 * circuits the gate (no HTTP, no credit) and returns card: null; in that case
 * no live graded entry is available this call, so resolveGradedPrice falls
 * through to the curated table / coarse multiplier (never a fabricated live
 * quote). A fresh pull returns the resolved ScrydexCard, from which we read
 * the PSA graded entry directly. Graded prices are not persisted (only raw is,
 * per §3.6), so a cache-hit intentionally serves the curated fallback rather
 * than burning a per-hit credit on a by-id refetch.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { pullAndStoreScrydexPrice } from "@/lib/services/scrydex-pricing.service";
import { pickGradedPrice, type ScrydexCard } from "@/lib/services/scrydex.service";
import { resolveGradedPrice } from "@/lib/utils/graded-price";
import { Game } from "@prisma/client";

/** One Piece externalIds are Bandai codes like "OP01-064"; the set code is
 *  the prefix before the dash ("OP01"). Pokémon externalIds (TCGdex, e.g.
 *  "base1-4") are NOT Scrydex expansion codes, so no setCode is derivable —
 *  Pokémon match on setName + collector number instead (NIT-3). */
function deriveOnePieceSetCode(externalId: string, game: Game): string | undefined {
  if (game !== Game.ONE_PIECE) return undefined;
  const prefix = externalId.split("-")[0];
  return /^(OP|ST|EB|PRB)\d{2}$/i.test(prefix) ? prefix.toUpperCase() : undefined;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: externalId } = await params;
  const grade = new URL(request.url).searchParams.get("grade") ?? "10";
  const nullPayload = { price: null, isFallback: true, isStale: true };

  try {
    // select has no set-code column (MEDIUM-2); we pass set.name only and
    // derive a One Piece set code from the externalId prefix where possible.
    const card = await prisma.card.findUnique({
      where: { externalId },
      select: {
        id: true,
        externalId: true,
        game: true,
        name: true,
        number: true,
        scrydexId: true,
        marketPrice: true,
        lastPricedAt: true,
        set: { select: { name: true } },
      },
    });

    if (!card || card.marketPrice == null) {
      return NextResponse.json(nullPayload, { headers: { "Cache-Control": "no-store" } });
    }

    // REAL graded price FIRST (AGENTS.md rule 2 — no fabricated prices). We now
    // store full per-grade graded CurrentPrice rows (company+grade+type, from
    // pullAndStoreScrydexPrice's full capture). When the requested PSA grade is
    // stored, return that exact value — this is the SAME number the detail-page
    // chips show (they read /prices), so the add-row and chip never disagree.
    // Only when no stored PSA row exists do we fall through to the gated Scrydex
    // refetch + curated/multiplier heuristic below.
    const storedGraded = await prisma.currentPrice.findFirst({
      where: {
        cardId: card.id,
        type: "graded",
        company: "PSA",
        grade,
        priceMarket: { not: null },
      },
      orderBy: { priceMarket: "desc" },
      select: { priceMarket: true, updatedAt: true },
    });
    if (storedGraded?.priceMarket != null) {
      return NextResponse.json(
        { price: storedGraded.priceMarket, isFallback: false, isStale: false },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // Route the Scrydex fetch through the central freshness gate + metering +
    // scrydexId write-back (MEDIUM-1). Returns the resolved ScrydexCard on a
    // fresh pull, or null when the 24h gate short-circuits (credit-free).
    // NIT-4: a SINGLE ScrydexCard | null local — no mismatched wrapper object.
    const scrydexCard: ScrydexCard | null = (
      await pullAndStoreScrydexPrice(
        {
          id: card.id,
          externalId: card.externalId,
          name: card.name,
          number: card.number,
          game: card.game,
          scrydexId: card.scrydexId,
          setName: card.set?.name ?? null,
          setCode: deriveOnePieceSetCode(card.externalId, card.game) ?? null,
        },
        { force: false }
      )
    ).card;

    const resolved = resolveGradedPrice({
      cardName: card.name,
      setName: card.set?.name ?? "",
      grade,
      rawMarketPrice: card.marketPrice,
      lastPricedAt: card.lastPricedAt,
      priceSource: () =>
        scrydexCard ? pickGradedPrice(scrydexCard, grade, "PSA")?.market ?? null : null,
    });

    return NextResponse.json(resolved, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[cards/graded] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(nullPayload, { headers: { "Cache-Control": "no-store" } });
  }
}
