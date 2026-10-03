/**
 * GET /api/cards/[id]/history — F-18 price history for one card.
 *
 * `[id]` is the EXTERNAL card id (e.g. "base1-4"), matching the sibling
 * /api/cards/[id]/prices route. Returns the stored PricingHistory points
 * ordered oldest → newest:
 *
 *   { points: [{ date: "YYYY-MM-DD", price: number }] }
 *
 * An empty `points` array means we have no real recorded history for the
 * card. Public card data — no auth, consistent with the other /api/cards
 * endpoints.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: externalId } = await params;

  // Always resolve to a points array. Unknown card, no history, or a DB
  // error all return `{ points: [] }` (200) so the detail page's chart shows
  // its honest empty state — a flat, label-less baseline (NOT a fabricated
  // mock series; the old mock curve was removed) — instead of a 404/500.
  try {
    const card = await prisma.card.findUnique({
      where: { externalId },
      select: { id: true },
    });
    if (!card) {
      return NextResponse.json({ points: [] }, { headers: { "Cache-Control": "no-store" } });
    }

    const rows = await prisma.pricingHistory.findMany({
      where: { cardId: card.id },
      orderBy: { recordedAt: "asc" },
      select: { priceMarket: true, recordedAt: true },
    });

    const points = rows
      .filter((r) => r.priceMarket != null) // NFR-2: never emit a fabricated 0 point
      .map((r) => ({
        date: r.recordedAt.toISOString().slice(0, 10),
        price: r.priceMarket as number,
      }));

    return NextResponse.json({ points }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[cards/history] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ points: [] }, { headers: { "Cache-Control": "no-store" } });
  }
}
