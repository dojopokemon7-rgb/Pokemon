/**
 * Daily OWNED-cards current-price refresh (ALL users).
 *
 * WHY this exists: current price must stay DAILY-fresh for cards users actually
 * hold, WITHOUT re-pricing the whole ~40-50k catalog. History / population /
 * deeper Scrydex data stay on their existing on-view 7-day cadence — this job
 * does NOT touch that. It only keeps the OWNED set's current price fresh in
 * between via the SINGLE current-price writer (pullAndStoreScrydexPrice).
 *
 * This is the ALL-USERS distinct owned set: the owned-cards query is NOT
 * user-scoped (no `userId` filter) — it is the union of every active holding
 * across every user, deduped by card. Compare with
 * POST /api/users/me/portfolio/refresh, which does the SAME per-card work for
 * ONE user; this is that logic widened to everyone and scheduled daily.
 *
 * TWO-ID RULE (AGENTS.md RULE 3): Scrydex resolves on externalId / scrydexId;
 * CurrentPrice + SyncLog key on the internal Card.id (cuid). The query selects
 * BOTH so pullAndStoreScrydexPrice can map each correctly — never confuse them.
 *
 * SPEND IS DOUBLE-BOUNDED (identical to portfolio/refresh):
 *   1. Credit gate (isScrydexLiveApproved): when live spend is NOT approved the
 *      whole run is a safe no-op — no DB read, no HTTP, zero credits.
 *   2. Per-card 24h gate inside pullAndStoreScrydexPrice: a card priced within
 *      the last 24h is skipped (no HTTP, no credit). We pass NO `force`, so a
 *      card not reached today (capped out) is still stale tomorrow and gets
 *      picked up on the next daily run — resumable without a cursor table.
 */
import { prisma } from "@/lib/db";
import { isScrydexLiveApproved } from "@/lib/services/scrydex-credit-gate";
import {
  pullAndStoreScrydexPrice,
  type ScrydexPullCard,
} from "@/lib/services/scrydex-pricing.service";

// ponytail: small concurrency pool — fast enough without hammering Scrydex /
// the DB pool with hundreds of parallel pulls. Ceiling: a fixed width; upgrade
// to an adaptive/token-bucket limiter if Scrydex rate-limits. (Mirrors
// portfolio/refresh's CONCURRENCY.)
const CONCURRENCY = 5;

// ponytail: hard cap on cards HANDED to the pool per run (counts iterated
// cards, matching portfolio/refresh's `.slice(0, cap)` semantics — not pulls,
// since skip-vs-pull is only known after the call; a run dominated by
// already-fresh cards spends ~0 credits anyway). Ceiling: owned cards beyond
// the cap wait for the next daily run (the 24h gate keeps already-priced cards
// cheap, so they drain over successive days). Upgrade path: order the owned set
// oldest-priced-first for strict fairness. Default 250 when unset.
const DEFAULT_CAP = 250;

// ponytail: wall-clock budget (~250s), analogous to the old daily sync's budget
// and inside the route's maxDuration=300. Ceiling: once exceeded we stop handing
// out NEW cards (in-flight pulls finish); the remainder waits for the next run.
const RUN_BUDGET_MS = 250_000;

// Distinct SyncLog job label for the per-run summary row. MUST NOT be
// "scrydex_history" (that label keys the per-card 24h freshness gate inside
// pullAndStoreScrydexPrice — reusing it would corrupt the gate).
const DAILY_OWNED_PRICE_JOB = "daily_owned_price";

export interface OwnedPriceRefreshSummary {
  reason?: "disabled";
  owned: number;
  attempted: number;
  refreshed: number;
  skipped: number;
  failed: number;
  credits: number;
}

/**
 * The ALL-USERS distinct owned-cards set, mapped to ScrydexPullCard.
 *
 * ONE scoped query over active holdings (isSold:false) across every user (NO
 * userId filter), deduped by Card.id in JS — mirrors portfolio/refresh's
 * mapping, so a card held by many users / in many collections is pulled once.
 * Selects BOTH id (CurrentPrice/SyncLog key) and externalId/scrydexId/name/
 * number/set (Scrydex resolution) per the two-id rule.
 */
export async function getOwnedCardsForRefresh(): Promise<ScrydexPullCard[]> {
  const holdings = await prisma.userCollection.findMany({
    where: { isSold: false },
    select: {
      card: {
        select: {
          id: true,
          externalId: true,
          name: true,
          number: true,
          game: true,
          scrydexId: true,
          set: { select: { name: true } },
        },
      },
    },
  });

  const byCardId = new Map<string, ScrydexPullCard>();
  for (const h of holdings) {
    const c = h.card;
    if (!c || byCardId.has(c.id)) continue;
    byCardId.set(c.id, {
      id: c.id,
      externalId: c.externalId,
      name: c.name,
      number: c.number,
      game: c.game,
      scrydexId: c.scrydexId,
      setName: c.set?.name ?? null,
    });
  }
  return [...byCardId.values()];
}

/**
 * Daily refresh of CURRENT price for the OWNED-cards set. Bounded + resumable.
 * Returns a summary (also written as a SyncLog row for admin/logs visibility).
 */
export async function refreshOwnedPrices(): Promise<OwnedPriceRefreshSummary> {
  const startedAt = Date.now();

  // --- Credit gate (SOFT) — safe no-op when spend is not approved ----------
  // No DB read, no HTTP, zero credits. Deny-by-default (AGENTS.md RULE 7).
  if (!(await isScrydexLiveApproved())) {
    console.log(
      "[daily-owned-price] skipped: credits not approved — no-op (no DB read, no spend)"
    );
    return {
      reason: "disabled",
      owned: 0,
      attempted: 0,
      refreshed: 0,
      skipped: 0,
      failed: 0,
      credits: 0,
    };
  }

  const owned = await getOwnedCardsForRefresh();
  const cap = Number(process.env.DAILY_OWNED_PRICE_CAP) || DEFAULT_CAP;
  const batch = owned.slice(0, cap);

  // Log the COUNT before spending so cost is observable in the logs BEFORE any
  // credit is burned (task requirement).
  console.log(
    `[daily-owned-price] owned=${owned.length} attempting=${batch.length} (cap=${cap}, budget=${RUN_BUDGET_MS}ms)`
  );

  let refreshed = 0;
  let skipped = 0;
  let failed = 0;
  let credits = 0;

  // Bounded-concurrency worker pool over a shared cursor. Each pull is already
  // fail-open internally; the per-card try/catch here guarantees one card's
  // failure never aborts the batch (RULE 7). A worker stops handing itself new
  // work once the wall-clock budget is exceeded — leftovers wait for next run.
  let cursor = 0;
  async function worker() {
    while (cursor < batch.length) {
      if (Date.now() - startedAt > RUN_BUDGET_MS) break;
      const card = batch[cursor++];
      try {
        // NO force — the built-in 24h gate skips cards priced in the last day,
        // so a card already fresh costs nothing (this is what makes the job
        // resumable across daily runs without a cursor table).
        const { pulled, credits: c } = await pullAndStoreScrydexPrice(card);
        if (pulled) refreshed++;
        else skipped++;
        credits += c;
      } catch {
        failed++;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batch.length) }, worker)
  );

  const attempted = refreshed + skipped + failed;

  // ONE summary SyncLog row so admin/logs show the run, counts, and credit-
  // equivalent total. ponytail: the schema has no counts columns, so the
  // human-readable tallies live in the free-text `error` column prefixed
  // "summary:" (honest, not an error); `credits` carries the real total.
  // Upgrade path: dedicated count columns if reporting needs them. Best-effort
  // — a log-write fault must not fail the (already-done) refresh.
  try {
    await prisma.syncLog.create({
      data: {
        job: DAILY_OWNED_PRICE_JOB,
        status: "ok",
        credits,
        error: `summary: owned=${owned.length} attempted=${attempted} refreshed=${refreshed} skipped=${skipped} failed=${failed}`,
      },
    });
  } catch (err) {
    console.warn(
      "[daily-owned-price] summary SyncLog write failed (non-fatal):",
      err instanceof Error ? err.message : err
    );
  }

  return { owned: owned.length, attempted, refreshed, skipped, failed, credits };
}
