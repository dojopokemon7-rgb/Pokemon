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
 *     population. Each pull is wrapped fail-open — a thrown
 *     ScrydexCreditsNotApproved (or any error) is swallowed, never a 5xx.
 *
 * PUBLIC card route (AGENTS.md rule 7): ALWAYS returns HTTP 200 with a small
 * JSON body — never 4xx/5xx — so the client's one-shot fetch is a silent no-op
 * on any failure and the existing read queries render stored data / "—".
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { redis, RedisKeys } from "@/lib/redis";
import { isScrydexOnViewApproved } from "@/lib/services/scrydex-credit-gate";
import {
  pullAndStoreScrydexHistory,
  pullAndStorePopulation,
} from "@/lib/services/scrydex-pricing.service";
import { getStoredPopulationReport } from "@/lib/services/population.service";

// On-view history is limited to this small, high-signal grade set (plus raw).
// Each (company,grade) is one extra Scrydex call, so we only pull the grades
// the card ACTUALLY has stored — never a speculative fan-out.
const ONVIEW_GRADES = new Set(["PSA|10", "PSA|9", "BGS|10", "CGC|10"]);

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
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

  // WEEKLY freshness: a card is re-enriched at most ONCE per 7 days. The first
  // view of a card pulls+stores (1 charge); every view inside the next 7 days is
  // free; after 7 days the next view refreshes once. `population_report.
  // refreshedAt` is the per-card "last enriched at" marker (enrich pulls history
  // + population together). We refresh when EITHER piece is missing OR the pop
  // marker is older than STALE_MS.
  const STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const hasHistory = (await prisma.pricingHistory.count({ where: { cardId: card.id } })) > 0;
  const pop = await getStoredPopulationReport(id);
  const popAgeMs = pop?.refreshedAt ? Date.now() - new Date(pop.refreshedAt).getTime() : Infinity;
  const isFresh = hasHistory && pop != null && popAgeMs < STALE_MS;
  if (isFresh) {
    return NextResponse.json({ enriched: false, reason: "fresh" }, { status: 200 });
  }
  // Not fresh → this is the once-per-week refresh (triggered BY the user opening
  // the card, never a background job). Refresh BOTH history and population so
  // the weekly spend keeps everything current together. Each pull is fail-open
  // (a ScrydexCreditsNotApproved or any throw must NOT 5xx — AGENTS.md rule 7).
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
      await pullAndStoreScrydexHistory(
        { id: card.id, game: card.game, scrydexId: card.scrydexId },
        { days: 365, grades }
      );
    } catch {
      // fail-open — never a 5xx (gate DENY / transient fault).
    }
  }

  {
    try {
      await pullAndStorePopulation({
        id: card.id,
        game: card.game,
        scrydexId: card.scrydexId,
        name: card.name,
        number: card.number,
        setName: card.set?.name ?? null,
      });
    } catch {
      // fail-open — never a 5xx.
    }
  }

  // Best-effort cache busting so the next GET re-reads fresh (fail-open).
  try {
    await redis.del(RedisKeys.cardHistory(id));
    await redis.del(RedisKeys.cardPopulation(id));
  } catch {
    // Redis optional — a cache fault never fails the request.
  }

  return NextResponse.json({ enriched: true }, { status: 200 });
}
