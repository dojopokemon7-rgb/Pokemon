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
      return NextResponse.json({ error: "Card not found" }, { status: 404 });
    }

    return NextResponse.json({ prices: card.currentPrices }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[cards/prices] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ prices: [] }, { status: 500 });
  }
}
