/**
 * POST /api/cards/[id]/enrich — ON-VIEW, store-once enrichment of a card's
 * price history + PSA population, called ONCE by the card-detail page on mount.
 *
 * `[id]` is the EXTERNAL card id (same convention as the sibling prices/history
 * routes). The route is deliberately CHEAP and idempotent:
 *   - Short-circuits to a no-op `{ enriched:false }` when the ON-VIEW allowance
 *     flag `SCRYDEX_ONVIEW_ENABLED` is OFF (isScrydexOnViewApproved). This is
 *     SEPARATE from the big-bulk credit gate — when off, NO Scrydex service is
 *     called at all, so dev/verification never spends a credit.
 *   - Short-circuits to `{ enriched:false, reason:"fresh" }` when the card
 *     already has stored history AND a stored population — store-once, no spend.
 *   - Otherwise pulls only what's missing: history (365d, limited to the card's
 *     actually-present raw + PSA 10/9 + BGS 10 + CGC 10 grades) and/or
 *     population. Both pulls are invoked with `creditAuth:"onview"` so the
 *     ON-VIEW allowance (SCRYDEX_ONVIEW_ENABLED) ALONE authorizes the spend —
 *     the big-bulk gate (SCRYDEX_LIVE_CREDITS_APPROVED) is NOT required and NOT
 *     widened (see assertScrydexEnrichApproved). Each pull is still wrapped
 *     fail-open — a thrown ScrydexCreditsNotApproved (when neither gate
 *     authorizes) or any error is swallowed, never a 5xx.
 *
 * PUBLIC card route (AGENTS.md rule 7): ALWAYS returns HTTP 200 with a small
 * JSON body — never 4xx/5xx — so the client's one-shot fetch is a silent no-op
 * on any failure and the existing read queries render stored data / "—".
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { redis, RedisKeys } from "@/lib/redis";
import { requireAuth } from "@/lib/utils/auth-guard";
import { enforceRateLimit, creditTier } from "@/lib/utils/rate-limit";
import { isScrydexOnViewApproved } from "@/lib/services/scrydex-credit-gate";
import {
  pullAndStoreScrydexHistory,
  pullAndStorePopulation,
} from "@/lib/services/scrydex-pricing.service";

// On-view enrich makes several SEQUENTIAL Scrydex round-trips (raw + graded
// price_history + population). The default serverless timeout (~10s Hobby)
// truncates the slow history write mid-pull, so give it an explicit budget —
// mirrors cron/sync-cards/route.ts. (Pro honours 60; Hobby caps at 60.)
export const maxDuration = 60;

// On-view history is limited to this small, high-signal grade set (plus raw).
// Each (company,grade) is one extra Scrydex call, so we only pull the grades
// the card ACTUALLY has stored — never a speculative fan-out.
const ONVIEW_GRADES = new Set(["PSA|10", "PSA|9", "BGS|10", "CGC|10"]);

// SyncLog job label for the per-card on-view enrich ATTEMPT marker. This is the
// per-card "last enriched at" clock (replacing the old population-presence
// heuristic) — a single const so the freshness read and the marker write can
// never drift. `SyncLog.job` is free-text, so this needs NO migration.
const ONVIEW_ENRICH_JOB = "scrydex_onview_enrich";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  // SECURITY: this POST can trigger a live Scrydex credit spend (history +
  // population). It is called ONLY from the authenticated card-detail page
  // (credentials:include on mount), so require a session — otherwise an
  // anonymous caller could iterate the catalog ids and drain credits even with
  // SCRYDEX_LIVE_CREDITS_APPROVED/SCRYDEX_ONVIEW_ENABLED on.
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;

  // Rate-limit by user BEFORE the card lookup + on-view gate + Scrydex pulls —
  // caps a client iterating card ids to drain history/population credits.
  const limited = await enforceRateLimit(request, creditTier(), {
    kind: "user",
    id: guard.session.user.id,
  });
  if (limited) return limited;

  const { id } = await params;

  // Unknown card → honest no-op (never a 4xx; the detail page still renders).
  const card = await prisma.card.findUnique({
    where: { externalId: id },
    select: {
      id: true,
      game: true,
      scrydexId: true,
      name: true,
      number: true,
      set: { select: { name: true } },
    },
  });
  if (!card) {
    return NextResponse.json({ enriched: false, reason: "unknown" }, { status: 200 });
  }

  // ON-VIEW allowance OFF → no-op, NO Scrydex service touched (asserted by test).
  if (!(await isScrydexOnViewApproved())) {
    return NextResponse.json({ enriched: false, reason: "disabled" }, { status: 200 });
  }

  // 24h freshness (owner spec): a card is re-enriched at most ONCE per 24h, and
  // ONLY when a user opens it — never a background job. The first open pulls+
  // stores (1 charge); every open inside the next 24h is free; the first open
  // AFTER 24h re-pulls once.
  //
  // FRESHNESS MARKER = a per-card `SyncLog(job="scrydex_onview_enrich")` row
  // written on EVERY enrich ATTEMPT (below). The OLD heuristic keyed freshness
  // on `population_report.refreshedAt` AND a stored-history row, which never
  // marked a card that LEGITIMATELY has no pop/history data (most One Piece
  // cards → getStoredPopulationReport == null): such a card was never "fresh",
  // so it re-pulled on EVERY open forever (audit 01 P-02 / 08 F-12). Keying on
  // the attempt marker instead means a pop-less / history-less card is still
  // throttled for 24h — the clock records that we TRIED, not that we found
  // data (RULE 2: the marker is an honest attempt timestamp, never fabricated
  // pop/history rows). History points stay date-keyed/immutable, so a re-pull
  // after 24h only ADDS a genuinely new day's point (skipDuplicates).
  const STALE_MS = 24 * 60 * 60 * 1000; // 24h — owner spec: re-pull on open only after 24h
  const lastEnrich = await prisma.syncLog.findFirst({
    where: { job: ONVIEW_ENRICH_JOB, cardId: card.id },
    orderBy: { ranAt: "desc" },
    select: { ranAt: true },
  });
  const isFresh = lastEnrich != null && Date.now() - lastEnrich.ranAt.getTime() < STALE_MS;
  if (isFresh) {
    return NextResponse.json({ enriched: false, reason: "fresh" }, { status: 200 });
  }
  // Not fresh → this is the once-per-24h refresh (triggered BY the user opening
  // the card, never a background job). Refresh BOTH history and population so
  // the on-open spend keeps everything current together. Each pull is fail-open
  // (a ScrydexCreditsNotApproved or any throw must NOT 5xx — AGENTS.md rule 7).
  // Surfaced in the 200 body so a swallowed/truncated write shows as stored:0
  // instead of being masked by a bare `enriched:true` (fail-open contract kept).
  let historyStored = 0;
  let populationStored = false;
  if (card.scrydexId) {
    // Only the card's actually-present raw + PSA 10/9 + BGS 10 + CGC 10 grades.
    const gradedRows = await prisma.currentPrice.findMany({
      where: { cardId: card.id, type: "graded", priceMarket: { not: null } },
      select: { company: true, grade: true },
    });
    const seen = new Set<string>();
    const grades: Array<{ company: string; grade: string }> = [];
    for (const r of gradedRows) {
      const company = (r.company ?? "").toUpperCase();
      const grade = r.grade ?? "";
      const key = `${company}|${grade}`;
      if (!ONVIEW_GRADES.has(key) || seen.has(key)) continue;
      seen.add(key);
      grades.push({ company, grade });
    }
    try {
      const r = await pullAndStoreScrydexHistory(
        { id: card.id, game: card.game, scrydexId: card.scrydexId },
        { days: 365, grades, creditAuth: "onview" }
      );
      historyStored = r.stored;
    } catch {
      // fail-open — never a 5xx (gate DENY / transient fault). stored stays 0.
    }
  }

  {
    try {
      const r = await pullAndStorePopulation(
        {
          id: card.id,
          game: card.game,
          scrydexId: card.scrydexId,
          name: card.name,
          number: card.number,
          setName: card.set?.name ?? null,
        },
        { creditAuth: "onview" }
      );
      populationStored = r.stored;
    } catch {
      // fail-open — never a 5xx. stored stays false.
    }
  }

  // Write the per-card freshness marker (the 24h clock) — ALWAYS when we reach
  // the pull branch, even if both pulls stored 0 or threw. The whole point is
  // to throttle pop-less / history-less cards: the credit spend already happened
  // (or was denied) on this attempt, so the 24h window starts now. credits:0 —
  // the marker is NOT itself a Scrydex call (history/population meter their own
  // SyncLog rows with the real credit cost). Fail-open (try/catch) so a marker-
  // write fault never 5xx (RULE 7).
  try {
    await prisma.syncLog.create({
      data: { job: ONVIEW_ENRICH_JOB, cardId: card.id, status: "ok", credits: 0 },
    });
  } catch {
    // Marker write is best-effort — never fail the request on it.
  }

  // Best-effort cache busting so the next GET re-reads fresh (fail-open).
  try {
    await redis.del(RedisKeys.cardHistory(id));
    await redis.del(RedisKeys.cardPopulation(id));
  } catch {
    // Redis optional — a cache fault never fails the request.
  }

  return NextResponse.json(
    { enriched: true, history: { stored: historyStored }, population: { stored: populationStored } },
    { status: 200 }
  );
}
