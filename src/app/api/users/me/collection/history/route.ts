import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/utils/auth-guard";

export async function GET(request: Request): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;

  const { session } = guard;
  const userId = session.user.id;

  const { searchParams } = new URL(request.url);
  const collectionIdsParam = searchParams.get("collectionIds");
  const collectionIds = collectionIdsParam ? collectionIdsParam.split(",") : ["null"];
  const range = searchParams.get("range") || "1M"; // "1M", "3M", "1Y", "ALL"

  try {
    const histories: Record<string, any[]> = {};
    
    // We will do this per collectionId for simplicity
    for (const collId of collectionIds) {
      // 1. Get active collection items
      const whereClause: any = { userId, isSold: false };
      if (collId === "null" || collId === "all") {
        // if "all" it means everything. if "null" it means main/uncategorized.
        if (collId === "null") whereClause.collectionId = null;
        // if "all", no collectionId filter needed
      } else {
        whereClause.collectionId = collId;
      }

      const items = await prisma.userCollection.findMany({
        where: whereClause,
        select: { cardId: true, quantity: true },
      });

      if (items.length === 0) {
        histories[collId] = [];
        continue;
      }

      // Group quantities by cardId
      const cardQuantities = new Map<string, number>();
      for (const item of items) {
        cardQuantities.set(item.cardId, (cardQuantities.get(item.cardId) || 0) + item.quantity);
      }
      const cardIds = Array.from(cardQuantities.keys());

      // 2. Fetch PricingHistory for these cards
      const now = new Date();
      let startDate = new Date();
      if (range === "1M") startDate.setMonth(now.getMonth() - 1);
      else if (range === "3M") startDate.setMonth(now.getMonth() - 3);
      else if (range === "12M" || range === "1Y") startDate.setFullYear(now.getFullYear() - 1);
      else startDate.setFullYear(now.getFullYear() - 5); // ALL

      const historyRows = await prisma.pricingHistory.findMany({
        where: {
          cardId: { in: cardIds },
          recordedAt: { gte: startDate },
        },
        orderBy: { recordedAt: "asc" },
        select: { cardId: true, recordedAt: true, priceMarket: true },
      });

      const pricesByDateAndCard = new Map<string, Map<string, number>>();
      const allDates = new Set<string>();

      for (const row of historyRows) {
        const dateStr = row.recordedAt.toISOString().slice(0, 10);
        allDates.add(dateStr);
        if (!pricesByDateAndCard.has(dateStr)) {
          pricesByDateAndCard.set(dateStr, new Map());
        }
        pricesByDateAndCard.get(dateStr)!.set(row.cardId, row.priceMarket ?? 0);
      }

      const sortedDates = Array.from(allDates).sort();
      const lastSeenPrices = new Map<string, number>();
      const history = [];

      for (const dateStr of sortedDates) {
        const dayPrices = pricesByDateAndCard.get(dateStr)!;
        let totalValue = 0;
        
        for (const cardId of cardIds) {
          if (dayPrices.has(cardId)) {
            lastSeenPrices.set(cardId, dayPrices.get(cardId)!);
          }
          const price = lastSeenPrices.get(cardId) || 0;
          totalValue += price * (cardQuantities.get(cardId) || 0);
        }
        
        history.push({ date: dateStr, value: totalValue });
      }
      histories[collId] = history;
    }

    return NextResponse.json({ histories });
  } catch (error) {
    console.error("[api/users/me/collection/history] Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
