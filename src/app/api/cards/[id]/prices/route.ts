import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: externalId } = await params;

  try {
    const card = await prisma.card.findUnique({
      where: { externalId },
      include: {
        currentPrices: true,
      },
    });

    if (!card) {
      // NFR-4: public card route — 200 + empty payload on unknown/err, never 4xx/5xx (UI renders "—").
      return NextResponse.json({ prices: [], weeklyChangePct: null }, { headers: { "Cache-Control": "no-store" } });
    }

    // weeklyChangePct is the REAL stored 7-day % change (Scrydex trends.days_7,
    // written by pullAndStoreScrydexPrice). Null until a priced pull runs — the
    // detail header then renders "—", never a fabricated number (AGENTS.md #2).
    return NextResponse.json(
      { prices: card.currentPrices, weeklyChangePct: card.weeklyChangePct ?? null },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[cards/prices] failed:", err instanceof Error ? err.message : err);
    // NFR-4: public card route — 200 + empty payload on unknown/err, never 4xx/5xx (UI renders "—").
    return NextResponse.json({ prices: [] }, { headers: { "Cache-Control": "no-store" } });
  }
}
