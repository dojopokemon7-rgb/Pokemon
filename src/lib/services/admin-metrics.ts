/**
 * Admin-metrics service — server-only.
 *
 * Centralises all portfolio / platform aggregations so the admin pages
 * stay declarative and every stat is computed the same way. Uses raw
 * SQL for sums (Prisma's `aggregate` cannot join across relations,
 * and iterating findMany over every UserCollection row would scale
 * poorly once the platform grows).
 *
 * Portfolio value = SUM(card.marketPrice * user_collection.quantity)
 * Total invested  = SUM(user_collection.purchasePrice * quantity)
 *                   where purchasePrice IS NOT NULL
 */

import { prisma } from "@/lib/db";

// ---------------------------------------------------------------------------
// Platform-wide
// ---------------------------------------------------------------------------

export interface PlatformStats {
  totalUsers: number;
  totalPlatformValue: number;      // Sum of live marketPrice * qty across all collections
  totalInvested: number;           // Sum of purchasePrice * qty across all collections
  totalCardsTracked: number;       // SUM(quantity) of every UserCollection row
  activeFloorListings: number;     // Stubbed to 0 until the Floor schema lands
}

export async function getPlatformStats(): Promise<PlatformStats> {
  const [totalUsers, valueRow, investedRow, qtyRow] = await Promise.all([
    prisma.user.count(),
    prisma.$queryRaw<{ total: number | null }[]>`
      SELECT COALESCE(SUM(c."marketPrice" * uc."quantity"), 0)::float AS total
      FROM "user_collection" uc
      JOIN "card" c ON c.id = uc."cardId"
      WHERE c."marketPrice" IS NOT NULL
    `,
    prisma.$queryRaw<{ total: number | null }[]>`
      SELECT COALESCE(SUM(uc."purchasePrice" * uc."quantity"), 0)::float AS total
      FROM "user_collection" uc
      WHERE uc."purchasePrice" IS NOT NULL
    `,
    prisma.userCollection.aggregate({
      _sum: { quantity: true },
    }),
  ]);

  return {
    totalUsers,
    totalPlatformValue: valueRow[0]?.total ?? 0,
    totalInvested: investedRow[0]?.total ?? 0,
    totalCardsTracked: qtyRow._sum.quantity ?? 0,
    // Query is ready and will return 0 today; swap the stub the moment
    // a `listing` (or equivalent) table is introduced:
    //   const activeFloorListings = await prisma.listing.count({
    //     where: { status: "ACTIVE" },
    //   });
    activeFloorListings: 0,
  };
}

// ---------------------------------------------------------------------------
// Platform-wide activity feed
// ---------------------------------------------------------------------------
//
// No AuditLog table exists yet, so the feed is derived from the real
// events we already capture: user signups + collection adds. This gives
// a truthful "last N actions" list today. Once a proper AuditLog model
// is introduced, replace the union below with a single query against it.
// ---------------------------------------------------------------------------

export interface PlatformActivityItem {
  id: string;
  kind: "user_joined" | "collection_added";
  timestamp: Date;
  actorName: string;
  actorEmail: string;
  actorId: string;
  cardName?: string;
  quantity?: number;
}

export async function getRecentPlatformActivity(
  limit = 10
): Promise<PlatformActivityItem[]> {
  const [recentAdds, recentUsers] = await Promise.all([
    prisma.userCollection.findMany({
      take: limit,
      orderBy: { addedAt: "desc" },
      select: {
        id: true,
        quantity: true,
        addedAt: true,
        user: { select: { id: true, name: true, email: true } },
        card: { select: { name: true } },
      },
    }),
    prisma.user.findMany({
      take: limit,
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, email: true, createdAt: true },
    }),
  ]);

  const items: PlatformActivityItem[] = [
    ...recentAdds.map<PlatformActivityItem>((r) => ({
      id: `add-${r.id}`,
      kind: "collection_added",
      timestamp: r.addedAt,
      actorName: r.user.name || r.user.email,
      actorEmail: r.user.email,
      actorId: r.user.id,
      cardName: r.card.name,
      quantity: r.quantity,
    })),
    ...recentUsers.map<PlatformActivityItem>((u) => ({
      id: `join-${u.id}`,
      kind: "user_joined",
      timestamp: u.createdAt,
      actorName: u.name || u.email,
      actorEmail: u.email,
      actorId: u.id,
    })),
  ];

  return items
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Per-user
// ---------------------------------------------------------------------------

export interface UserFinancials {
  portfolioValue: number;
  totalInvested: number | null; // null when no purchasePrice recorded on ANY row
  /** Value − Invested. `null` when Total Invested is unknown. */
  profitLoss: number | null;
  cardsOwned: number;           // SUM(quantity)
  hasAnyPurchasePrice: boolean;
}

export async function getUserFinancials(userId: string): Promise<UserFinancials> {
  const [valueRow, investedRow, qtyRow, priceRow] = await Promise.all([
    prisma.$queryRaw<{ total: number | null }[]>`
      SELECT COALESCE(SUM(c."marketPrice" * uc."quantity"), 0)::float AS total
      FROM "user_collection" uc
      JOIN "card" c ON c.id = uc."cardId"
      WHERE uc."userId" = ${userId} AND c."marketPrice" IS NOT NULL
    `,
    prisma.$queryRaw<{ total: number | null }[]>`
      SELECT COALESCE(SUM(uc."purchasePrice" * uc."quantity"), 0)::float AS total
      FROM "user_collection" uc
      WHERE uc."userId" = ${userId} AND uc."purchasePrice" IS NOT NULL
    `,
    prisma.userCollection.aggregate({
      where: { userId },
      _sum: { quantity: true },
    }),
    prisma.userCollection.count({
      where: { userId, purchasePrice: { not: null } },
    }),
  ]);

  const hasAnyPurchasePrice = priceRow > 0;
  const portfolioValue = valueRow[0]?.total ?? 0;
  const totalInvested = hasAnyPurchasePrice ? investedRow[0]?.total ?? 0 : null;

  return {
    portfolioValue,
    totalInvested,
    profitLoss: totalInvested == null ? null : portfolioValue - totalInvested,
    cardsOwned: qtyRow._sum.quantity ?? 0,
    hasAnyPurchasePrice,
  };
}

// ---------------------------------------------------------------------------
// Portfolio value for many users at once — used by the Users list to show
// each row's current portfolio value without N+1 queries.
// ---------------------------------------------------------------------------

export async function getPortfolioValuesByUser(
  userIds: readonly string[]
): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();

  const rows = await prisma.$queryRaw<
    { userId: string; total: number | null }[]
  >`
    SELECT uc."userId" AS "userId",
           COALESCE(SUM(c."marketPrice" * uc."quantity"), 0)::float AS total
    FROM "user_collection" uc
    JOIN "card" c ON c.id = uc."cardId"
    WHERE uc."userId" = ANY(${userIds as string[]})
      AND c."marketPrice" IS NOT NULL
    GROUP BY uc."userId"
  `;

  const map = new Map<string, number>();
  for (const r of rows) map.set(r.userId, r.total ?? 0);
  return map;
}
