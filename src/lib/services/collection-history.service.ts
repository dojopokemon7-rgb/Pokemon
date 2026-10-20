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
import {
  parseGradedCondition,
  pickGradedVariant,
  type PriceRowLike,
} from "@/lib/utils/raw-price";

const DAY_MS = 24 * 60 * 60 * 1000;

// A — real moving time-series (owner-confirmed): a recent-but-real portfolio
// flows through the DENSE daily grid below, so its line MOVES with the real
// stored PricingHistory (carry-forward) instead of being flattened. The old
// QA #6b short-window branch replaced the dense grid with a 2-point FLAT line
// whenever the earliest lot was added within SHORT_WINDOW_DAYS — that masked
// genuine price movement on a freshly-built portfolio. It is removed: the dense
// grid is already honest (carry-forward of REAL points, honest null gaps
// otherwise — RULE 2), and the page's >=2-real-points empty state still guards
// genuinely sparse portfolios ("Not enough history to chart yet").

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
        // BUG 1 & 8: carry each lot's graded condition ("PSA 10", "CGC 9.5") or
        // raw ("NM"/null) so the series values it from the matching grade's
        // price points. UserCollection has NO per-lot variant column — per-lot
        // uniqueness is isFoil+condition — so we thread condition only.
        condition: true,
      },
    });

    if (lots.length === 0) {
      histories[collId] = [];
      continue;
    }

    const cardIds = Array.from(new Set(lots.map((l) => l.cardId)));

    // CROSS-SNAPSHOT PARITY (review-blocking): decide each graded lot's VARIANT
    // over the STABLE current-price snapshot — the SAME CurrentPrice rows the
    // display/accounting path (pickRealGradedPrice → displayPrice/statsFromLots)
    // reads — and thread it onto the holding so the chart filters its windowed
    // history to that exact variant. Without this, the chart derives the variant
    // from windowed PricingHistory while display derives it from the latest
    // CurrentPrice; when a company+grade's VARIANT SET differs between those two
    // snapshots (history: {normal,holofoil}; current: {holofoil}) the two paths
    // pick different variants and disagree. Deciding it once here, from current,
    // keeps them in lockstep. Prisma-only, ZERO credits. If history later lacks a
    // point for the chosen variant the lot stays an honest null gap (RULE 2).
    const currentGraded = await prisma.currentPrice.findMany({
      where: { cardId: { in: cardIds }, type: "graded", priceMarket: { not: null } },
      select: { cardId: true, company: true, grade: true, variant: true, priceMarket: true },
    });
    // Per-card current graded rows → the ONE shared selector picks the variant.
    const currentGradedByCard = new Map<string, PriceRowLike[]>();
    for (const r of currentGraded) {
      const arr = currentGradedByCard.get(r.cardId) ?? [];
      arr.push({
        type: "graded",
        company: r.company == null ? r.company : r.company.toUpperCase(),
        grade: r.grade,
        variant: r.variant,
        priceMarket: r.priceMarket,
      });
      currentGradedByCard.set(r.cardId, arr);
    }
    // Memoize the variant decision per (cardId, company, grade) — the identical
    // rule pickRealGradedPrice uses, so chart and display agree by construction.
    const variantCache = new Map<string, string | null>();
    function currentGradedVariant(
      cardId: string,
      condition: string | null | undefined
    ): string | null | undefined {
      const parsed = parseGradedCondition(condition);
      if (!parsed) return undefined; // raw lot — no graded variant decision
      const company = parsed.company.toUpperCase();
      const key = `${cardId}\u0000${company}\u0000${parsed.grade}`;
      if (variantCache.has(key)) return variantCache.get(key);
      const rows = currentGradedByCard.get(cardId) ?? [];
      // pickGradedVariant returns null when current has NO matching graded row.
      // We keep that null so the chart (filtering to a null variant) yields an
      // honest gap rather than falling back to a history-derived variant — the
      // display path returns null here too (and then falls to the coarse
      // multiplier), so a lot the current snapshot can't price graded does not
      // get an invented history variant.
      const v = pickGradedVariant(rows, company, parsed.grade);
      variantCache.set(key, v);
      return v;
    }

    const holdings: HoldingInterval[] = lots.map((l) => ({
      collectionId: collId,
      cardId: l.cardId,
      quantity: l.quantity,
      addedAt: l.addedAt.getTime(),
      // A sold lot stops contributing at soldAt; an active lot never ends.
      soldAt: l.isSold && l.soldAt ? l.soldAt.getTime() : null,
      // BUG 1 & 8: value this lot from the price series matching its grade.
      condition: l.condition,
      // Cross-snapshot parity: the variant display priced this lot at (current
      // snapshot). undefined for a raw lot → chart uses the raw series.
      gradedVariant: currentGradedVariant(l.cardId, l.condition),
    }));
    const rows = await prisma.pricingHistory.findMany({
      where: { cardId: { in: cardIds }, recordedAt: { gte: startDate } },
      orderBy: { recordedAt: "asc" },
      // BUG 1 & 8: carry the per-row grade identity (type/company/grade/variant)
      // so buildCollectionSeries can value each lot from the matching series
      // instead of whichever row sorts last.
      select: {
        cardId: true,
        recordedAt: true,
        priceMarket: true,
        type: true,
        company: true,
        grade: true,
        variant: true,
        condition: true,
      },
    });

    const prices: PricePoint[] = rows
      .filter((r) => r.priceMarket != null) // never a fabricated 0
      .map((r) => ({
        cardId: r.cardId,
        at: r.recordedAt.getTime(),
        price: r.priceMarket as number,
        type: r.type,
        company: r.company,
        grade: r.grade,
        variant: r.variant,
        condition: r.condition,
      }));

    // Daily timeline from the window start to now (inclusive).
    const startMs = startDate.getTime();
    const nowMs = now.getTime();

    const timeline: number[] = [];
    // Daily grid instants (startMs + k·DAY_MS), ascending. Each carries the
    // window-start time-of-day, NOT local/UTC midnight.
    const gridSteps: number[] = [];
    for (let t = startMs; t <= nowMs; t += DAY_MS) {
      timeline.push(t);
      gridSteps.push(t);
    }
    // The series always ends exactly at `now` (it may differ from the last grid
    // step by < 1 day). Track whether that endpoint is an EXTRA valued instant
    // (distinct from the last grid step) so the anchor-dedup counts it too.
    const nowIsExtra = gridSteps[gridSteps.length - 1] !== nowMs;

    // Inject each lot's acquisition instant as a timeline anchor. The ownership
    // gate (collection-series.ts `if (t < lot.addedAt) continue`) nulls every
    // timeline instant BEFORE `addedAt`, so a lot can only be valued at instants
    // >= addedAt. Those are a trailing suffix of the ascending grid plus the
    // `now` endpoint. The chart needs >= 2 drawable (non-null) points to render.
    //
    // Keep the addedAt anchor ONLY when the grid+endpoint would otherwise give
    // the lot FEWER than 2 valued instants — i.e. when fewer than 2 grid
    // instants are >= addedAt (counting the extra `now` endpoint). This covers:
    //   • a lot added ~now (its day's grid instant ≈ now is the sole >= addedAt
    //     grid point) — the anchor is its distinct 2nd point;
    //   • a lot added mid-day on a PAST day (its own day's grid instant carries
    //     the start-of-window time-of-day and is < addedAt, so it is nulled;
    //     only the following day's grid instant / `now` is >= addedAt) — the
    //     anchor supplies the valued point on its own day, giving 2 total.
    // A lot held across many whole grid days already has >= 2 valued grid
    // instants, so its clamped near-startMs anchor is a redundant duplicate and
    // is dropped. This generalizes the old "today" special-case to every past
    // day — fixing past-day mid-day adds for portfolio "all", the dashboard's
    // per-collection series, and the single-collection view in this one builder.
    //
    // Also clamp each addedAt into [startMs, nowMs] so no point lands left of
    // the window, and skip a lot already sold before the window opened.
    // ponytail: O(lots · log grid) via the binary count below — fine at per-user
    // lot counts; if a user ever holds thousands of lots, bucket anchors by day.
    for (const l of lots) {
      if (l.isSold && l.soldAt && l.soldAt.getTime() < startMs) continue;
      const added = l.addedAt.getTime();
      if (!Number.isFinite(added)) continue;
      // Count grid steps >= added (ascending → a trailing suffix). binary search
      // for the first index whose instant is >= added; suffix length = count.
      let lo = 0;
      let hi = gridSteps.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (gridSteps[mid] >= added) hi = mid;
        else lo = mid + 1;
      }
      let valuedGrid = gridSteps.length - lo;
      if (nowIsExtra && nowMs >= added) valuedGrid += 1; // the `now` endpoint
      if (valuedGrid >= 2) continue; // grid alone already gives >= 2 valued points
      const anchor = Math.min(Math.max(added, startMs), nowMs);
      timeline.push(anchor);
    }

    // Ensure the series ends exactly at `now`.
    if (timeline[timeline.length - 1] !== nowMs) timeline.push(nowMs);

    timeline.sort((a, b) => a - b);
    const deduped = timeline.filter((t, i) => i === 0 || t !== timeline[i - 1]);

    const [series] = buildCollectionSeries(holdings, prices, deduped);
    histories[collId] = (series?.points ?? []).map((p) => ({
      date: new Date(p.t).toISOString().slice(0, 10),
      value: p.value, // null = honest gap (chart skips it)
    }));
  }

  return histories;
}
