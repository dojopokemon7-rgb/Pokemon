import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { RedisKeys, CACHE_TTL } from "@/lib/redis";
import { cacheGetJson, cacheSetJson } from "@/lib/utils/cache";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: externalId } = await params;

  // USER-AGNOSTIC, DB-read-only cache keyed by externalId (RULE 3 — `[id]` is
  // the catalog external id). No Scrydex call here, so no credit impact. A
  // Redis fault falls through to the live Prisma read.
  const cacheKey = RedisKeys.cardPrices(externalId);
  const cached = await cacheGetJson<{ prices: unknown[]; weeklyChangePct: number | null }>(cacheKey);
  if (cached) {
    return NextResponse.json(cached, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const card = await prisma.card.findUnique({
      where: { externalId },
      include: {
        currentPrices: true,
      },
    });

    if (!card) {
      // NFR-4: public card route — 200 + empty payload on unknown/err, never 4xx/5xx (UI renders "—").
      const empty = { prices: [], weeklyChangePct: null };
      // Cache the empty result too (unknown externalId legitimately empty),
      // kept short by the same TTL.
      await cacheSetJson(cacheKey, empty, CACHE_TTL.cardPrices);
      return NextResponse.json(empty, { headers: { "Cache-Control": "no-store" } });
    }

    // weeklyChangePct is the REAL stored 7-day % change (Scrydex trends.days_7,
    // written by pullAndStoreScrydexPrice). Null until a priced pull runs — the
    // detail header then renders "—", never a fabricated number (AGENTS.md #2).
    const payload = { prices: card.currentPrices, weeklyChangePct: card.weeklyChangePct ?? null };
    await cacheSetJson(cacheKey, payload, CACHE_TTL.cardPrices);
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[cards/prices] failed:", err instanceof Error ? err.message : err);
    // NFR-4: public card route — 200 + empty payload on unknown/err, never 4xx/5xx (UI renders "—").
    return NextResponse.json({ prices: [] }, { headers: { "Cache-Control": "no-store" } });
  }
}
