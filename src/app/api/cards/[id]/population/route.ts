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
import { z } from "zod";
import {
  getStoredPopulationReport,
  BGS_POPULATION_SUPPORTED,
} from "@/lib/services/population.service";
import { RedisKeys, CACHE_TTL } from "@/lib/redis";
import { cacheGetJson, cacheSetJson } from "@/lib/utils/cache";

// RULE 4: the exact shape this route caches. Used ONLY to re-validate the Redis
// blob on READ — a stale OLD-shape blob fails this and is treated as a miss
// (fall through to the live stored read), never served. `report` is a real
// object when present (only non-null reports are ever cached).
const PopulationCacheSchema = z.object({
  report: z.object({}).passthrough(),
  bgsSupported: z.boolean(),
});

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
  const rawCached = await cacheGetJson<unknown>(cacheKey);
  if (rawCached != null) {
    const parsed = PopulationCacheSchema.safeParse(rawCached);
    if (parsed.success) {
      return NextResponse.json(parsed.data, { headers: { "Cache-Control": "private, max-age=86400" } });
    }
    // parse miss (stale OLD-shape blob) → fall through to the live stored read.
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
