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
      return NextResponse.json({ prices: [] }, { headers: { "Cache-Control": "no-store" } });
    }

    return NextResponse.json({ prices: card.currentPrices }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[cards/prices] failed:", err instanceof Error ? err.message : err);
    // NFR-4: public card route — 200 + empty payload on unknown/err, never 4xx/5xx (UI renders "—").
    return NextResponse.json({ prices: [] }, { headers: { "Cache-Control": "no-store" } });
  }
}
