/**
 * GET /api/cards/[id]/history — F-18 price history for one card.
 *
 * `[id]` is the EXTERNAL card id (e.g. "base1-4"), matching the sibling
 * /api/cards/[id]/prices route. Returns the stored PricingHistory points
 * ordered oldest → newest:
 *
 *   { points: [{ date: "YYYY-MM-DD", price: number }] }
 *
 * An empty `points` array means we have no recorded history for the card
 * (the caller then falls back to the mock chart generator). Public card
 * data — no auth, consistent with the other /api/cards endpoints.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: externalId } = await params;

  const card = await prisma.card.findUnique({
    where: { externalId },
    select: { id: true },
  });

  if (!card) {
    return NextResponse.json(
      { error: "Not Found", message: "Card not found." },
      { status: 404 }
    );
  }

  const rows = await prisma.pricingHistory.findMany({
    where: { cardId: card.id },
    orderBy: { recordedAt: "asc" },
    select: { price: true, recordedAt: true },
  });

  const points = rows.map((r) => ({
    date: r.recordedAt.toISOString().slice(0, 10),
    price: r.price,
  }));

  return NextResponse.json({ points }, { headers: { "Cache-Control": "no-store" } });
}
