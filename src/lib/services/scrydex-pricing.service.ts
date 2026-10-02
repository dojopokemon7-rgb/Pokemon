/**
 * Scrydex pricing orchestrator — the SINGLE WRITER for Scrydex-sourced
 * pricing (FR-4, design §3.6). This is the ONLY place that:
 *   - owns the 24h freshness gate (keyed on the newest
 *     SyncLog(job="scrydex_history", cardId).ranAt),
 *   - performs the first-pull trend backfill (PricingHistory only,
 *     source="scrydex-trend"),
 *   - meters credits into SyncLog.
 *
 * Centralising these here is deliberate: the daily sync AND the backfill
 * script both call pullAndStoreScrydexPrice, so the gate, the first-pull
 * invariant, and the normalization rule cannot drift between callers
 * (bug-fix-the-shared-function discipline). The thin scrydex.service.ts
 * client stays Prisma-free (AGENTS.md §5.11); all DB side effects live here.
 *
 * NEVER fabricate data: a missing real value stays null (UI → "—"); prices
 * are only ever filtered out, never coerced to 0. The ONE sanctioned derived
 * series is the first-pull trend backfill, explicitly labelled
 * source="scrydex-trend".
 */
import { prisma } from "@/lib/db";
import { DataSource, Game } from "@prisma/client";
import {
  fetchScrydexCardById,
  resolveScrydexCard,
  pickRawPrice,
  type ScrydexCard,
} from "./scrydex.service";

// ponytail: global 24h staleness window — the smallest honest cadence that
// keeps credit burn ~1/card/day. Ceiling: a card re-priced <24h ago won't
// refresh even if the market moved intraday. Upgrade path: per-card
// volatility-driven windows.
export const SCRYDEX_STALE_MS = 24 * 60 * 60 * 1000;

// ponytail: provisional — the FR-7 pilot MEASURES real cost; update this
// constant from the pilot's reported burn before any bulk backfill.
export const SCRYDEX_CREDITS_PER_CALL = 1;

const SCRYDEX_HISTORY_JOB = "scrydex_history";

export interface ScrydexPullCard {
  id: string;
  externalId: string;
  name: string;
  number: string;
  game: Game;
  scrydexId?: string | null;
  setName?: string | null;
  setCode?: string | null;
}

/**
 * Pull a card's live Scrydex price and store it (store-once / reuse / grow).
 *
 * Flow (design §3.6):
 *   1. Freshness gate (unless opts.force): skip entirely when the newest
 *      SyncLog(job="scrydex_history", cardId) ranAt is within SCRYDEX_STALE_MS
 *      — no HTTP, no row. Gated on SyncLog (NOT CurrentPrice) so a graded-only
 *      / no-raw card is still throttled for 24h instead of re-pulled every run.
 *   2. Pull: by cached scrydexId when present, else resolve by name+number+set
 *      and cache the resolved id. null/throw → failed SyncLog, return.
 *   3. Persist the fresh raw point → one PricingHistory (source="scrydex") +
 *      upsert one CurrentPrice (source=SCRYDEX).
 *   4. First-pull only: derive up to 3 scrydex-trend points from the trend
 *      deltas (market − price_change at −1/−7/−14d). PricingHistory ONLY.
 *   5. Meter: SyncLog(status="ok", credits) on success.
 */
export async function pullAndStoreScrydexPrice(
  card: ScrydexPullCard,
  opts?: { force?: boolean }
): Promise<{ pulled: boolean; credits: number; card: ScrydexCard | null }> {
  // --- 1. Freshness gate ---------------------------------------------------
  // When the gate short-circuits we have NOT fetched a ScrydexCard this call,
  // so we return `card: null`. Callers that need the resolved card on a fresh
  // view (e.g. the graded route) read the STORED graded price instead — the
  // gate exists precisely so a repeat public view costs no credit.
  if (!opts?.force) {
    const last = await prisma.syncLog.findFirst({
      where: { job: SCRYDEX_HISTORY_JOB, cardId: card.id },
      orderBy: { ranAt: "desc" },
      select: { ranAt: true },
    });
    if (last && Date.now() - last.ranAt.getTime() < SCRYDEX_STALE_MS) {
      return { pulled: false, credits: 0, card: null };
    }
  }

  // --- 2. Pull (native-id resolution) --------------------------------------
  let scrydexCard: ScrydexCard | null = null;
  let resolvedId: string | null = card.scrydexId ?? null;
  try {
    if (card.scrydexId) {
      scrydexCard = await fetchScrydexCardById(card.scrydexId, card.game);
    } else {
      const resolved = await resolveScrydexCard({
        name: card.name,
        number: card.number,
        setName: card.setName ?? undefined,
        setCode: card.setCode ?? undefined,
        game: card.game,
      });
      if (resolved) {
        scrydexCard = resolved.card;
        resolvedId = resolved.scrydexId;
      }
    }
  } catch (err) {
    scrydexCard = null;
    console.warn(
      `[scrydex-pricing] pull ${card.externalId} threw:`,
      err instanceof Error ? err.message : err
    );
  }

  if (!scrydexCard) {
    await prisma.syncLog.create({
      data: {
        job: SCRYDEX_HISTORY_JOB,
        cardId: card.id,
        status: "failed",
        credits: 0,
        error: `No Scrydex match for ${card.externalId} (${card.name})`,
      },
    });
    return { pulled: false, credits: 0, card: null };
  }

  // Cache the resolved native id for the next pull (search → by-id path).
  if (resolvedId && resolvedId !== card.scrydexId) {
    try {
      await prisma.card.update({
        where: { id: card.id },
        data: { scrydexId: resolvedId },
      });
    } catch {
      // A unique-collision or missing row must not fail the pull — the id is
      // just a cache; a re-resolve next run is harmless.
    }
  }

  const raw = pickRawPrice(scrydexCard);
  const now = new Date();

  if (raw) {
    const variant = raw.variant;
    const condition = raw.condition;
    const currency = raw.currency;

    // --- 4 (checked BEFORE the insert): is this the first pull? -----------
    // Count existing scrydex/scrydex-trend rows for this (cardId, variant,
    // condition) namespace — the trend backfill runs ONLY on the first pull.
    const existingSeries = await prisma.pricingHistory.count({
      where: {
        cardId: card.id,
        source: { in: ["scrydex", "scrydex-trend"] },
        variant,
        condition,
      },
    });

    // --- 3. Persist the fresh point --------------------------------------
    await prisma.pricingHistory.createMany({
      data: [
        {
          cardId: card.id,
          priceMarket: raw.market,
          priceLow: raw.low,
          source: "scrydex",
          currency,
          variant,
          condition,
          recordedAt: now,
        },
      ],
      skipDuplicates: true,
    });

    await prisma.currentPrice.upsert({
      where: {
        cardId_source_currency_variant_condition: {
          cardId: card.id,
          source: DataSource.SCRYDEX,
          currency,
          variant,
          condition,
        },
      },
      update: { priceMarket: raw.market, priceLow: raw.low },
      create: {
        cardId: card.id,
        source: DataSource.SCRYDEX,
        currency,
        variant,
        condition,
        priceMarket: raw.market,
        priceLow: raw.low,
      },
    });

    // --- 4. First-pull trend backfill (PricingHistory ONLY) --------------
    if (existingSeries === 0 && raw.market != null && raw.trends) {
      const trendPoints = buildTrendBackfill(raw.market, raw.trends, now).map(
        (p) => ({
          cardId: card.id,
          priceMarket: p.priceMarket,
          priceLow: null,
          source: "scrydex-trend",
          currency,
          variant,
          condition,
          recordedAt: p.recordedAt,
        })
      );
      if (trendPoints.length > 0) {
        await prisma.pricingHistory.createMany({
          data: trendPoints,
          skipDuplicates: true,
        });
      }
    }
  }

  // --- 5. Credit metering --------------------------------------------------
  // One HTTP fetch happened (resolve-search OR by-id), so meter one call
  // regardless of whether a raw price existed. The trend backfill adds no
  // extra credits (derived from the same single response).
  await prisma.syncLog.create({
    data: {
      job: SCRYDEX_HISTORY_JOB,
      cardId: card.id,
      status: "ok",
      credits: SCRYDEX_CREDITS_PER_CALL,
    },
  });

  return { pulled: true, credits: SCRYDEX_CREDITS_PER_CALL, card: scrydexCard };
}

/**
 * Derive up to 3 prior absolute price points from the rolling trend deltas
 * (design §3.6 step 4, OQ#2). `price_change` is an ABSOLUTE USD delta in the
 * verified payload, so the prior price is `market − price_change`. A missing
 * delta skips that point (never fabricate). Pure + exported for unit testing.
 */
export function buildTrendBackfill(
  market: number,
  trends: NonNullable<ReturnType<typeof pickRawPrice>>["trends"],
  now: Date
): Array<{ recordedAt: Date; priceMarket: number }> {
  if (!trends) return [];
  const DAY_MS = 24 * 60 * 60 * 1000;
  const spec: Array<{ days: number; delta: number | null | undefined }> = [
    { days: 1, delta: trends.days_1?.price_change },
    { days: 7, delta: trends.days_7?.price_change },
    { days: 14, delta: trends.days_14?.price_change },
  ];
  const out: Array<{ recordedAt: Date; priceMarket: number }> = [];
  for (const { days, delta } of spec) {
    if (typeof delta !== "number" || !Number.isFinite(delta)) continue;
    const prior = market - delta;
    if (!Number.isFinite(prior) || prior <= 0) continue; // never fabricate a <=0 point
    out.push({
      recordedAt: new Date(now.getTime() - days * DAY_MS),
      priceMarket: prior,
    });
  }
  return out;
}
