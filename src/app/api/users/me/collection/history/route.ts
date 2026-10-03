/**
 * GET /api/users/me/collection/history — per-collection value history for the
 * dashboard comparison chart.
 *
 *   ?collectionIds=<id,id,...|null|all>&range=1M|3M|1Y|ALL
 *   → { histories: { [collectionId]: [{ date, value }] } }
 *
 * Plan §6 (honest, ownership-aware): a lot contributes to a collection's value
 * ONLY within its ownership interval `[addedAt, soldAt)` — we never value a card
 * before it was added or after it was sold. Value uses the nearest REAL stored
 * price at/before each date (carry-forward); a lot with no real price yet simply
 * doesn't contribute (honest gap, never a fabricated $0). One series per
 * collection — never summed. The pure math lives in `buildCollectionSeries`.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/utils/auth-guard";
import {
  buildCollectionSeries,
  type HoldingInterval,
  type PricePoint,
} from "@/lib/utils/collection-series";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET(request: Request): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;
  const userId = guard.session.user.id;

  const { searchParams } = new URL(request.url);
  const collectionIdsParam = searchParams.get("collectionIds");
  const collectionIds = collectionIdsParam ? collectionIdsParam.split(",") : ["null"];
  const range = searchParams.get("range") || "1M";

  // Range → window start.
  const now = new Date();
  const startDate = new Date(now);
  if (range === "1D") startDate.setDate(now.getDate() - 1);
  else if (range === "7D") startDate.setDate(now.getDate() - 7);
  else if (range === "1M") startDate.setMonth(now.getMonth() - 1);
  else if (range === "3M") startDate.setMonth(now.getMonth() - 3);
  else if (range === "6M") startDate.setMonth(now.getMonth() - 6);
  else if (range === "12M" || range === "1Y") startDate.setFullYear(now.getFullYear() - 1);
  else startDate.setFullYear(now.getFullYear() - 5); // ALL / MAX

  try {
    const histories: Record<string, { date: string; value: number | null }[]> = {};

    for (const collId of collectionIds) {
      // Ownership-scoped lots. Include SOLD lots too — they contribute within
      // their [addedAt, soldAt) window and then drop out (correct history).
      const where: {
        userId: string;
        collectionId?: string | null;
      } = { userId };
      if (collId === "null") where.collectionId = null;
      else if (collId !== "all") where.collectionId = collId;
      // "all" → no collectionId filter (every owned lot, incl. unassigned).

      const lots = await prisma.userCollection.findMany({
        where,
        select: {
          cardId: true,
          quantity: true,
          addedAt: true,
          soldAt: true,
          isSold: true,
        },
      });

      if (lots.length === 0) {
        histories[collId] = [];
        continue;
      }

      const holdings: HoldingInterval[] = lots.map((l) => ({
        collectionId: collId,
        cardId: l.cardId,
        quantity: l.quantity,
        addedAt: l.addedAt.getTime(),
        // A sold lot stops contributing at soldAt; an active lot never ends.
        soldAt: l.isSold && l.soldAt ? l.soldAt.getTime() : null,
      }));

      const cardIds = Array.from(new Set(lots.map((l) => l.cardId)));
      const rows = await prisma.pricingHistory.findMany({
        where: { cardId: { in: cardIds }, recordedAt: { gte: startDate } },
        orderBy: { recordedAt: "asc" },
        select: { cardId: true, recordedAt: true, priceMarket: true },
      });

      const prices: PricePoint[] = rows
        .filter((r) => r.priceMarket != null) // never a fabricated 0
        .map((r) => ({ cardId: r.cardId, at: r.recordedAt.getTime(), price: r.priceMarket as number }));

      // Daily timeline from the window start to now (inclusive).
      const timeline: number[] = [];
      for (let t = startDate.getTime(); t <= now.getTime(); t += DAY_MS) timeline.push(t);
      if (timeline[timeline.length - 1] !== now.getTime()) timeline.push(now.getTime());

      const [series] = buildCollectionSeries(holdings, prices, timeline);
      histories[collId] = (series?.points ?? []).map((p) => ({
        date: new Date(p.t).toISOString().slice(0, 10),
        value: p.value, // null = honest gap (chart skips it)
      }));
    }

    return NextResponse.json({ histories });
  } catch (error) {
    console.error("[api/users/me/collection/history] Error:", error);
    // Graceful: empty histories rather than a 500 so the chart renders its
    // "no price history yet" state.
    return NextResponse.json({ histories: {} }, { status: 200 });
  }
}
