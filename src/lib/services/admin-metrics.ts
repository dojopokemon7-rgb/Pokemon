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
  fillScanDailyRange,
  toCumulative,
  utcDayKey,
  type DailyCount,
  type ScanDailyCount,
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

// ---------------------------------------------------------------------------
// Detail analytics (FEAT-001) — scan usage, portfolio totals, per-game split,
// active users, top wanted / most scanned cards.
//
// All REAL aggregations (AGENTS.md rule 2): grouped SQL over actual rows, honest
// zeros for quiet days / empty [] for empty ranges. Financial sums keep the
// isSold=false exclusion (BUG-3) and the documented raw-for-graded caveat.
// ---------------------------------------------------------------------------

/** A gap-filled scan-activity series plus the window-wide roll-ups. */
export interface ScanUsageSeries {
  /** Gap-free daily success/fail counts over the range (UTC day keys). */
  points: ScanDailyCount[];
  totalScans: number;
  successfulScans: number;
  failedScans: number;
  /**
   * ESTIMATE of Scrydex Vision credits consumed by scans in-range: successful
   * scans whose ocrSource='vision' * 5. SyncLog.credits does NOT meter Vision
   * scans, so this is derived, not read back — hence "estimated". A scan that
   * was abandoned before a pick counts as a FAIL (pickedCardId IS NULL), which
   * is honest: no card was confirmed.
   */
  estimatedVisionCredits: number;
}

/** Credits a single successful Scrydex Vision identify consumes (per AGENTS.md). */
const VISION_CREDITS_PER_SCAN = 5;

/**
 * Per-UTC-day scan activity: total scans, successful (pickedCardId NOT NULL) vs
 * failed (total − success), gap-filled over the range. Also returns window-wide
 * totals and an ESTIMATE of Vision credits spent (see ScanUsageSeries doc).
 */
export async function getScanUsageSeries(
  days = ANALYTICS_RANGE_DAYS
): Promise<ScanUsageSeries> {
  const start = rangeStart(days);

  const rows = await prisma.$queryRaw<
    { day: Date; total: bigint; success: bigint; visionSuccess: bigint }[]
  >`
    SELECT date_trunc('day', "createdAt" AT TIME ZONE 'UTC') AS day,
           COUNT(*)::bigint AS total,
           COUNT("pickedCardId")::bigint AS success,
           COUNT(*) FILTER (
             WHERE "pickedCardId" IS NOT NULL AND "ocrSource" = 'vision'
           )::bigint AS "visionSuccess"
    FROM "scan_feedback"
    WHERE "createdAt" >= ${start}
    GROUP BY day
    ORDER BY day
  `;

  const daily: ScanDailyCount[] = rows.map((r) => {
    const total = Number(r.total);
    const success = Number(r.success);
    return { date: utcDayKey(new Date(r.day)), success, fail: total - success };
  });
  const points = fillScanDailyRange(daily, start, new Date());

  let totalScans = 0;
  let successfulScans = 0;
  let visionSuccesses = 0;
  for (const r of rows) {
    totalScans += Number(r.total);
    successfulScans += Number(r.success);
    visionSuccesses += Number(r.visionSuccess);
  }

  return {
    points,
    totalScans,
    successfulScans,
    failedScans: totalScans - successfulScans,
    estimatedVisionCredits: visionSuccesses * VISION_CREDITS_PER_SCAN,
  };
}

/** Platform-wide active-holdings portfolio roll-up. */
export interface PortfolioTotals {
  /** SUM(card.marketPrice * qty) over active (isSold=false) lots; raw-for-graded. */
  totalPortfolioValue: number;
  /** SUM(quantity) over active (isSold=false) lots. */
  activeCards: number;
  totalUsers: number;
  /** activeCards / totalUsers, or 0 when there are no users. */
  averageCollectionSize: number;
}

/**
 * Platform active-holdings totals: aggregate market value and owned quantity over
 * NON-sold lots (isSold=false, matching getPlatformStats / BUG-3), plus the
 * average active collection size per user (guarded against divide-by-zero).
 *
 * Value uses the RAW card.marketPrice for every lot, graded included — the same
 * DOCUMENTED raw-for-graded limitation as getPlatformStats (see file header).
 */
export async function getPortfolioTotals(): Promise<PortfolioTotals> {
  const [valueRow, qtyRow, totalUsers] = await Promise.all([
    prisma.$queryRaw<{ total: number | null }[]>`
      SELECT COALESCE(SUM(c."marketPrice" * uc."quantity"), 0)::float AS total
      FROM "user_collection" uc
      JOIN "card" c ON c.id = uc."cardId"
      WHERE c."marketPrice" IS NOT NULL AND uc."isSold" = false
    `,
    prisma.$queryRaw<{ total: number | null }[]>`
      SELECT COALESCE(SUM(uc."quantity"), 0)::bigint AS total
      FROM "user_collection" uc
      WHERE uc."isSold" = false
    `,
    prisma.user.count(),
  ]);

  const totalPortfolioValue = valueRow[0]?.total ?? 0;
  const activeCards = Number(qtyRow[0]?.total ?? 0);
  const averageCollectionSize = totalUsers > 0 ? activeCards / totalUsers : 0;

  return { totalPortfolioValue, activeCards, totalUsers, averageCollectionSize };
}

/** Owned-quantity split across the two supported games (active lots only). */
export interface PerGameSplit {
  pokemon: number;
  onePiece: number;
}

/**
 * Owned-card quantity split by game (POKEMON vs ONE_PIECE), summing NON-sold lots
 * (isSold=false). A game with no active holdings is an honest 0 (the grouped row
 * simply doesn't appear, and we default each game to 0).
 */
export async function getPerGameSplit(): Promise<PerGameSplit> {
  const rows = await prisma.$queryRaw<{ game: string; total: bigint }[]>`
    SELECT c."game"::text AS game,
           SUM(uc."quantity")::bigint AS total
    FROM "user_collection" uc
    JOIN "card" c ON c.id = uc."cardId"
    WHERE uc."isSold" = false
    GROUP BY c."game"
  `;

  const byGame = new Map<string, number>();
  for (const r of rows) byGame.set(r.game, Number(r.total));
  return {
    pokemon: byGame.get("POKEMON") ?? 0,
    onePiece: byGame.get("ONE_PIECE") ?? 0,
  };
}

/** Distinct-session active user counts over the last day / week. */
export interface ActiveUsers {
  dau: number;
  wau: number;
}

/**
 * Active users = DISTINCT session.userId with a session touched recently. We use
 * Session.updatedAt as the activity proxy: Better Auth refreshes it on session
 * use, so a recent updatedAt means the user was actually active (vs createdAt,
 * which only marks sign-in). DAU = within 1 day, WAU = within 7 days.
 */
export async function getActiveUsers(): Promise<ActiveUsers> {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [dauRow, wauRow] = await Promise.all([
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(DISTINCT "userId")::bigint AS count
      FROM "session"
      WHERE "updatedAt" >= ${dayAgo}
    `,
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(DISTINCT "userId")::bigint AS count
      FROM "session"
      WHERE "updatedAt" >= ${weekAgo}
    `,
  ]);

  return {
    dau: Number(dauRow[0]?.count ?? 0),
    wau: Number(wauRow[0]?.count ?? 0),
  };
}

/** A ranked card entry (wanted or scanned) with its lookup name. */
export interface RankedCard {
  /** EXTERNAL catalog id (RULE 3) — want_list_item.cardId / scan_feedback.pickedCardId. */
  cardId: string;
  /** Card.name resolved via externalId; null when the id isn't in the catalog. */
  name: string | null;
  count: number;
}

/**
 * The N most-wanted cards across every want list: group want_list_item by cardId
 * (an EXTERNAL id per RULE 3), COUNT(*), order desc. LEFT JOIN card ON
 * card.externalId so a wanted-but-uncatalogued id still appears with a null name
 * (honest — we don't invent a label). Returns [] when nothing is wanted.
 */
export async function getTopWantedCards(limit = 10): Promise<RankedCard[]> {
  const rows = await prisma.$queryRaw<
    { cardId: string; name: string | null; total: bigint }[]
  >`
    SELECT wli."cardId" AS "cardId",
           c."name"     AS name,
           COUNT(*)::bigint AS total
    FROM "want_list_item" wli
    LEFT JOIN "card" c ON c."externalId" = wli."cardId"
    GROUP BY wli."cardId", c."name"
    ORDER BY total DESC
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    cardId: r.cardId,
    name: r.name,
    count: Number(r.total),
  }));
}

/**
 * The N most-scanned-and-picked cards: group scan_feedback by the non-null
 * pickedCardId (an EXTERNAL id per RULE 3), COUNT(*), order desc. LEFT JOIN card
 * ON card.externalId for the name (null if uncatalogued). Abandoned scans
 * (pickedCardId NULL) are excluded — they identify no card. [] when empty.
 */
export async function getMostScannedCards(limit = 10): Promise<RankedCard[]> {
  const rows = await prisma.$queryRaw<
    { cardId: string; name: string | null; total: bigint }[]
  >`
    SELECT sf."pickedCardId" AS "cardId",
           c."name"          AS name,
           COUNT(*)::bigint  AS total
    FROM "scan_feedback" sf
    LEFT JOIN "card" c ON c."externalId" = sf."pickedCardId"
    WHERE sf."pickedCardId" IS NOT NULL
    GROUP BY sf."pickedCardId", c."name"
    ORDER BY total DESC
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    cardId: r.cardId,
    name: r.name,
    count: Number(r.total),
  }));
}
