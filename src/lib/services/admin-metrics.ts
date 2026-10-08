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
 *
 * SOLD lots (isSold = true) are EXCLUDED from value / invested (BUG-3 fix) so
 * a disposed holding isn't counted as if still held — matching the user-facing
 * portfolio engine (statsFromLots). The quantity sum (cardsOwned) and the
 * activity series deliberately count ALL rows (an add is an activity signal).
 *
 * GRADED CAVEAT: these SQL sums use the RAW card.marketPrice for every lot,
 * including graded ones (e.g. "PSA 10"). The user-facing portfolio resolves
 * graded holdings to their graded price (graded-price.ts) in JS, but that
 * helper can't be called cheaply from SQL, so admin value stays raw-for-graded
 * as a DOCUMENTED limitation. Reconciling would require post-fetch JS graded
 * resolution per row rather than a risky SQL port of the lookup table.
 */

import { prisma } from "@/lib/db";
import {
  fillDailyRange,
  toCumulative,
  utcDayKey,
  type DailyCount,
} from "@/lib/utils/admin-analytics";

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
      WHERE c."marketPrice" IS NOT NULL AND uc."isSold" = false
    `,
    prisma.$queryRaw<{ total: number | null }[]>`
      SELECT COALESCE(SUM(uc."purchasePrice" * uc."quantity"), 0)::float AS total
      FROM "user_collection" uc
      WHERE uc."purchasePrice" IS NOT NULL AND uc."isSold" = false
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
      WHERE uc."userId" = ${userId} AND c."marketPrice" IS NOT NULL AND uc."isSold" = false
    `,
    prisma.$queryRaw<{ total: number | null }[]>`
      SELECT COALESCE(SUM(uc."purchasePrice" * uc."quantity"), 0)::float AS total
      FROM "user_collection" uc
      WHERE uc."userId" = ${userId} AND uc."purchasePrice" IS NOT NULL AND uc."isSold" = false
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
      AND uc."isSold" = false
    GROUP BY uc."userId"
  `;

  const map = new Map<string, number>();
  for (const r of rows) map.set(r.userId, r.total ?? 0);
  return map;
}

// ---------------------------------------------------------------------------
// Time-series analytics (admin overview charts)
// ---------------------------------------------------------------------------
//
// REAL aggregations only (AGENTS.md rule 2): each series is a grouped SQL count
// over actual rows. A day with no rows is a true 0 (fillDailyRange densifies the
// range), NOT a fabricated point; an empty range returns [] so the UI renders an
// honest "No data yet" state. All buckets are UTC days (date_trunc AT TIME ZONE
// 'UTC') so the server's local timezone can't shift a row into the wrong day.
// ---------------------------------------------------------------------------

/** Default analytics window — last 90 days of daily buckets. */
export const ANALYTICS_RANGE_DAYS = 90;

/** Start Date (UTC midnight) `days` before today, inclusive. */
function rangeStart(days: number): Date {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start;
}

export interface TimeSeries {
  /** Gap-free daily points over the range (UTC day keys). */
  points: DailyCount[];
}

/**
 * Cumulative total users over time — the growth curve. Counts new users per UTC
 * day in-range, densifies the range, then runs a cumulative total seeded by the
 * number of users that already existed BEFORE the window (so the curve starts at
 * the real platform total, not 0).
 */
export async function getUserGrowthSeries(
  days = ANALYTICS_RANGE_DAYS
): Promise<TimeSeries> {
  const start = rangeStart(days);

  const [rows, baselineRow] = await Promise.all([
    prisma.$queryRaw<{ day: Date; count: bigint }[]>`
      SELECT date_trunc('day', "createdAt" AT TIME ZONE 'UTC') AS day,
             COUNT(*)::bigint AS count
      FROM "user"
      WHERE "createdAt" >= ${start}
      GROUP BY day
      ORDER BY day
    `,
    prisma.user.count({ where: { createdAt: { lt: start } } }),
  ]);

  const daily: DailyCount[] = rows.map((r) => ({
    date: utcDayKey(new Date(r.day)),
    count: Number(r.count),
  }));
  const filled = fillDailyRange(daily, start, new Date());
  return { points: toCumulative(filled, baselineRow) };
}

/**
 * Cards added to collections per UTC day across the whole platform. Counts ALL
 * add rows (including rows later marked isSold — the add still happened; this is
 * an activity signal, not a current-holdings signal). One grouped query, no N+1.
 */
export async function getCardsAddedSeries(
  days = ANALYTICS_RANGE_DAYS
): Promise<TimeSeries> {
  const start = rangeStart(days);

  const rows = await prisma.$queryRaw<{ day: Date; count: bigint }[]>`
    SELECT date_trunc('day', "addedAt" AT TIME ZONE 'UTC') AS day,
           COUNT(*)::bigint AS count
    FROM "user_collection"
    WHERE "addedAt" >= ${start}
    GROUP BY day
    ORDER BY day
  `;

  const daily: DailyCount[] = rows.map((r) => ({
    date: utcDayKey(new Date(r.day)),
    count: Number(r.count),
  }));
  return { points: fillDailyRange(daily, start, new Date()) };
}

export interface TopCollectedCard {
  cardId: string;
  name: string;
  totalQuantity: number;
}

/**
 * The N most-collected cards across every user: group user_collection by cardId,
 * SUM(quantity), join card.name, order by summed quantity desc. Real counts only;
 * returns [] when nothing is collected yet.
 */
export async function getTopCollectedCards(
  limit = 10
): Promise<TopCollectedCard[]> {
  const rows = await prisma.$queryRaw<
    { cardId: string; name: string; total: bigint }[]
  >`
    SELECT uc."cardId" AS "cardId",
           c."name"    AS name,
           SUM(uc."quantity")::bigint AS total
    FROM "user_collection" uc
    JOIN "card" c ON c.id = uc."cardId"
    GROUP BY uc."cardId", c."name"
    ORDER BY total DESC
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    cardId: r.cardId,
    name: r.name,
    totalQuantity: Number(r.total),
  }));
}
