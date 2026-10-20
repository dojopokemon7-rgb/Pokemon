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

// QA #6b: ALL/MAX builds a DAILY grid spanning 5 years, but the ownership gate
// nulls every instant before the earliest lot's addedAt. A brand-new portfolio
// (all lots added within the last couple of days) therefore survives only the
// few daily-grid instants inside that tiny real window — and because there are
// still >= 3 of them crammed into ~2 days, AreaChart's Catmull-Rom smoothing
// bows their near-identical carried-forward values into a DRAMATIC multi-peak
// "swoosh" with a big filled area, implying a price trend that did NOT happen.
// When the earliest valued instant is this recent, a dense daily grid invents
// no values (carry-forward is honest) but its DENSITY is what the smoothing
// exaggerates. The honest fix: over ALL/MAX, when the real window is shorter
// than this, emit a SPARSE series of the real valuation instants only (each
// lot's clamped addedAt + now) instead of the dense grid — few points → the
// chart draws an honest near-flat line/markers (hasAreaTrend < 3 → no area),
// never a fabricated trend. Longer real history keeps the full dense grid and
// its genuine shape. 7 days is comfortably inside any real multi-month trend.
const SHORT_WINDOW_DAYS = 7;

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

  // ALL/MAX is the only range whose grid spans years (5y back) — the only one
  // where a ~2-day-old portfolio's few surviving grid points get smoothed into
  // a fake swoosh (QA #6b). Bounded ranges (1D–1Y) already window tightly, so
  // the sparse-window shaping below is gated to ALL/MAX only.
  const isAllRange =
    range !== "1D" &&
    range !== "7D" &&
    range !== "1M" &&
    range !== "3M" &&
    range !== "6M" &&
    range !== "12M" &&
    range !== "1Y";

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
    const startMs = startDate.getTime();
    const nowMs = now.getTime();

    // QA #6b — sparse short-window path (ALL/MAX only). The real valued window
    // begins at the EARLIEST lot addedAt (nothing is valued before it). When
    // that earliest add is within SHORT_WINDOW_DAYS of now, the dense 5-year
    // daily grid contributes only a few points in that tiny window, which the
    // chart smooths into a fake multi-peak trend. Instead emit ONLY the real
    // valuation instants: each lot's clamped addedAt + the `now` endpoint. No
    // value is invented (buildCollectionSeries still carry-forwards real prices
    // and emits honest null gaps); the series is just SPARSE, so the chart reads
    // as a near-flat honest line/markers rather than a smoothed swoosh.
    const addedTimes = lots
      .map((l) => l.addedAt.getTime())
      .filter((t) => Number.isFinite(t));
    const earliestAdded = addedTimes.length ? Math.min(...addedTimes) : nowMs;
    if (isAllRange && earliestAdded >= nowMs - SHORT_WINDOW_DAYS * DAY_MS) {
      // Anchors = each lot's addedAt clamped into [startMs, nowMs], plus now.
      // (startMs is 5y back, so the clamp is effectively addedAt here, but kept
      // for safety against a future-dated/negative addedAt.) Dedup + sort below.
      const anchors = addedTimes.map((t) => Math.min(Math.max(t, startMs), nowMs));
      anchors.push(nowMs);
      anchors.sort((a, b) => a - b);
      const sparse = anchors.filter((t, i) => i === 0 || t !== anchors[i - 1]);
      const [series] = buildCollectionSeries(holdings, prices, sparse);
      histories[collId] = (series?.points ?? []).map((p) => ({
        date: new Date(p.t).toISOString().slice(0, 10),
        value: p.value,
      }));
      continue;
    }

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
