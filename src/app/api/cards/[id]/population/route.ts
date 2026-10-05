/**
 * GET /api/cards/[id]/population — population report for the detail page.
 *
 * PLAN CONSTRAINT (§4): population is Pokémon PSA-English ONLY (Scrydex public
 * coverage); BGS is unavailable and never fabricated. This GET is a pure READ of
 * STORED population — it performs no live, credit-consuming fetch. A real refresh
 * is a MANUAL, owner-approval-gated action (POST, below). Until a card has been
 * refreshed, `report` is null and the UI shows the fallback state (never
 * invented numbers).
 *
 * Always 200 (never 500) so the detail page renders regardless.
 */

import { NextResponse } from "next/server";
import {
  getStoredPopulationReport,
  BGS_POPULATION_SUPPORTED,
} from "@/lib/services/population.service";
import { RedisKeys, CACHE_TTL } from "@/lib/redis";
import { cacheGetJson, cacheSetJson } from "@/lib/utils/cache";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  // USER-AGNOSTIC cache keyed by externalId (RULE 3). This is a READ of STORED
  // population only — getStoredPopulationReport makes NO live, credit-consuming
  // Scrydex fetch, so caching it has no credit impact. A Redis fault falls
  // through to the live stored read below.
  const cacheKey = RedisKeys.cardPopulation(id);
  const cached = await cacheGetJson<{ report: unknown; bgsSupported: boolean }>(cacheKey);
  if (cached) {
    return NextResponse.json(cached, { headers: { "Cache-Control": "private, max-age=86400" } });
  }

  try {
    const report = await getStoredPopulationReport(id);
    const payload = { report, bgsSupported: BGS_POPULATION_SUPPORTED };
    // Only cache a REAL report. A null report means this card hasn't been
    // refreshed yet; pinning that null for the full 24h TTL would mask a
    // report that lands after first view (a manual refresh / enrich best-effort
    // DELs this key, but if that runs on another instance or Redis is briefly
    // unreachable the null blob survives a FULL DAY) — "empty-cache poisoning".
    // A null report is a cheap stored read, so skip the write.
    if (report != null) {
      await cacheSetJson(cacheKey, payload, CACHE_TTL.cardPopulation);
    }
    return NextResponse.json(
      payload,
      { headers: { "Cache-Control": "private, max-age=86400" } }
    );
  } catch (err) {
    console.error("[cards/population] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ report: null, bgsSupported: BGS_POPULATION_SUPPORTED }, { status: 200 });
  }
}
