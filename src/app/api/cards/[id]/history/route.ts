/**
 * GET /api/cards/[id]/history — F-18 per-grade price history for one card.
 *
 * `[id]` is the EXTERNAL card id (e.g. "base1-4"), matching the sibling
 * /api/cards/[id]/prices route. Returns the stored PricingHistory points
 * ordered oldest → newest, PARTITIONED into a raw series and a map of
 * per-grade graded series:
 *
 *   {
 *     raw: [{ date: "YYYY-MM-DD", price: number }],
 *     graded: { "PSA|10": [{ date, price }], "CGC|9.5": [...] }
 *   }
 *
 * A `type==="graded"` row with both company and grade is keyed under
 * `graded["${company}|${grade}"]`; everything else is `raw`. Empty series
 * ({ raw: [], graded: {} }) means we have no real recorded history. Public
 * card data — no auth, consistent with the other /api/cards endpoints.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { RedisKeys, CACHE_TTL } from "@/lib/redis";
import { cacheGetJson, cacheSetJson } from "@/lib/utils/cache";

// Zod at the boundary (RULE 4): the assembled payload is .parse()d before send,
// and a cached blob is safeParse()d on read — a stale {points} blob (the OLD
// shape) fails the parse and falls through to the live Postgres read.
const HistoryPointSchema = z.object({ date: z.string(), price: z.number() });
const HistoryResponseSchema = z.object({
  raw: z.array(HistoryPointSchema),
  graded: z.record(z.string(), z.array(HistoryPointSchema)),
});
type HistoryResponse = z.infer<typeof HistoryResponseSchema>;

const EMPTY: HistoryResponse = { raw: [], graded: {} };

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: externalId } = await params;

  // USER-AGNOSTIC, DB-read-only cache keyed by externalId (RULE 3). No Scrydex
  // call here. A Redis fault — or a stale {points} blob that fails the keyed
  // parse — falls through to the live Prisma read below (fail-open). The cache
  // key version is intentionally NOT bumped; the parse guard handles stale blobs.
  const cacheKey = RedisKeys.cardHistory(externalId);
  const rawCached = await cacheGetJson<unknown>(cacheKey);
  if (rawCached != null) {
    const parsed = HistoryResponseSchema.safeParse(rawCached);
    if (parsed.success) {
      return NextResponse.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
    }
    // parse miss (stale OLD-shape blob) → fall through to Postgres.
  }

  // Always resolve to the keyed shape. Unknown card, no history, or a DB error
  // all return { raw: [], graded: {} } (200) so the detail page's chart shows
  // its honest empty state instead of a 404/500.
  try {
    const card = await prisma.card.findUnique({
      where: { externalId },
      select: { id: true },
    });
    if (!card) {
      // Cache the empty result too (unknown externalId legitimately empty).
      await cacheSetJson(cacheKey, EMPTY, CACHE_TTL.cardHistory);
      return NextResponse.json(EMPTY, { headers: { "Cache-Control": "no-store" } });
    }

    const rows = await prisma.pricingHistory.findMany({
      where: { cardId: card.id },
      orderBy: { recordedAt: "asc" },
      select: { priceMarket: true, recordedAt: true, type: true, company: true, grade: true },
    });

    const raw: { date: string; price: number }[] = [];
    const graded: Record<string, { date: string; price: number }[]> = {};
    for (const r of rows) {
      if (r.priceMarket == null) continue; // NFR-2: never emit a fabricated 0 point
      const point = {
        date: r.recordedAt.toISOString().slice(0, 10),
        price: r.priceMarket,
      };
      if (r.type === "graded" && r.company && r.grade) {
        const key = `${r.company}|${r.grade}`;
        (graded[key] ??= []).push(point);
      } else {
        raw.push(point);
      }
    }

    const payload = HistoryResponseSchema.parse({ raw, graded });
    await cacheSetJson(cacheKey, payload, CACHE_TTL.cardHistory);
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[cards/history] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(EMPTY, { headers: { "Cache-Control": "no-store" } });
  }
}
