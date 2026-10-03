/**
 * collection-history.service — server-only builder for the dashboard
 * comparison chart's per-collection value history.
 *
 * EXTRACTED (ssr-dashboard-chart) from the GET
 * /api/users/me/collection/history route so BOTH the route AND the dashboard
 * server component can build the SAME histories from ONE source of truth —
 * guaranteeing the SSR-computed default-range data is byte-for-byte identical
 * to what the client's first `["portfolio-history", collectionIdsQuery, range]`
 * fetch would have returned (no divergence, no post-mount skeleton flash).
 *
 * Plan §6 (honest, ownership-aware): a lot contributes to a collection's value
 * ONLY within its ownership interval `[addedAt, soldAt)` — we never value a card
 * before it was added or after it was sold. Value uses the nearest REAL stored
 * price at/before each date (carry-forward); a lot with no real price yet simply
 * doesn't contribute (honest gap, never a fabricated $0). One series per
 * collection — never summed. The pure math lives in `buildCollectionSeries`.
 *
 * Server-only: imports `@/lib/db` (Prisma). Never import from client code.
 * Prisma-only; ZERO credits, NO Scrydex/external calls.
 */
import { prisma } from "@/lib/db";
import {
  buildCollectionSeries,
  type HoldingInterval,
  type PricePoint,
} from "@/lib/utils/collection-series";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build per-collection value histories for one user over `range`.
 *
 * `collectionIds` are the per-series buckets the caller wants — the SAME tokens
 * the API param carries: `"null"` → the uncategorized (collectionId = null)
 * lots; `"all"` → every owned lot (no collectionId filter); anything else →
 * that literal `collectionId`. (The client's first-render sentinel `"__uncat__"`
 * is NOT `"null"`, so it filters `collectionId = "__uncat__"`, matches no rows,
 * and yields an empty series — this CURRENT behavior is reproduced verbatim so
 * SSR and the client agree exactly.)
 *
 * Returns the SAME `histories` map the route body built: one key per requested
 * `collId`, each an array of `{ date, value }` (value null = honest gap).
 */
export async function buildCollectionHistories(
  userId: string,
  collectionIds: string[],
  range: string
): Promise<Record<string, { date: string; value: number | null }[]>> {
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

  return histories;
}
