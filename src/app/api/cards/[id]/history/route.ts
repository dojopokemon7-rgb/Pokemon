/**
 * GET /api/cards/[id]/history — F-18 per-grade price history for one card.
 *
 * `[id]` is the EXTERNAL card id (e.g. "base1-4"), matching the sibling
 * /api/cards/[id]/prices route. Optional `?variant=` selects ONE stored variant
 * (default = the card's headline variant, pickDefaultVariant of its CurrentPrice
 * rows; else the most common variant in history). Returns the stored
 * PricingHistory points ordered oldest → newest, PARTITIONED into a raw series
 * and a map of per-grade graded series:
 *
 *   {
 *     raw: [{ date: "YYYY-MM-DD", price: number }],
 *     graded: { "PSA|10": [{ date, price }], "CGC|9.5": [...] },
 *     variants: ["holofoil", "reverseHolofoil"]   // variants present in history
 *   }
 *
 * A `type==="graded"` row with both company and grade is keyed under
 * `graded["${company}|${grade}"]`; everything else is `raw`. The raw series uses
 * ONLY the best-ranked raw condition present for the variant (NM, else LP..DM —
 * never several conditions merged), and multiple points on one ISO date collapse
 * to the last. Empty series ({ raw: [], graded: {}, variants: [] }) means we have
 * no real recorded history. Public card data — no auth.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { RedisKeys, CACHE_TTL } from "@/lib/redis";
import { cacheGetJson, cacheSetJson } from "@/lib/utils/cache";
import { RAW_CONDITION_ORDER, listVariants, pickDefaultVariant } from "@/lib/utils/raw-price";

// Zod at the boundary (RULE 4): the assembled payload is .parse()d before send,
// and a cached blob is safeParse()d on read — a stale blob without `variants`
// (the OLD shape) fails the parse and falls through to the live Postgres read.
const HistoryPointSchema = z.object({ date: z.string(), price: z.number() });
const HistoryResponseSchema = z.object({
  raw: z.array(HistoryPointSchema),
  graded: z.record(z.string(), z.array(HistoryPointSchema)),
  variants: z.array(z.string()),
});
type HistoryResponse = z.infer<typeof HistoryResponseSchema>;
type Point = { date: string; price: number };

const EMPTY: HistoryResponse = { raw: [], graded: {}, variants: [] };

// Unknown conditions rank after DM so they only win when nothing better exists.
const condRank = (c: string | null | undefined): number => {
  const i = (RAW_CONDITION_ORDER as readonly string[]).indexOf(c ?? "");
  return i === -1 ? RAW_CONDITION_ORDER.length : i;
};

/** Append `point`; a second point on the same ISO date replaces the previous one (last wins). */
function pushCollapsed(series: Point[], point: Point): void {
  const last = series[series.length - 1];
  if (last && last.date === point.date) last.price = point.price;
  else series.push(point);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: externalId } = await params;
  const variantParam = new URL(request.url).searchParams.get("variant");

  // USER-AGNOSTIC, DB-read-only cache keyed by externalId (RULE 3). No Scrydex
  // call here. Only the DEFAULT-variant response (no ?variant=) is cached, so
  // the enrich route's single DEL of this key still busts everything; explicit
  // variants are a cheap DB read. A Redis fault — or a stale blob that fails the
  // parse — falls through to the live Prisma read below (fail-open).
  const cacheKey = RedisKeys.cardHistory(externalId);
  if (!variantParam) {
    const rawCached = await cacheGetJson<unknown>(cacheKey);
    if (rawCached != null) {
      const parsed = HistoryResponseSchema.safeParse(rawCached);
      if (parsed.success) {
        return NextResponse.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
      }
      // parse miss (stale OLD-shape blob) → fall through to Postgres.
    }
  }

  // Always resolve to the keyed shape. Unknown card, no history, or a DB error
  // all return an empty payload (200) so the detail page's chart shows its
  // honest empty state instead of a 404/500.
  try {
    const card = await prisma.card.findUnique({
      where: { externalId },
      select: { id: true },
    });
    if (!card) {
      // Do NOT cache the empty result (empty-cache poisoning: enrich pulls
      // history AFTER first view, often on another instance where the
      // best-effort cache DEL can't reach this entry).
      return NextResponse.json(EMPTY, { headers: { "Cache-Control": "no-store" } });
    }

    const rows = await prisma.pricingHistory.findMany({
      where: { cardId: card.id },
      orderBy: { recordedAt: "asc" },
      select: {
        priceMarket: true, recordedAt: true, type: true, company: true, grade: true,
        variant: true, condition: true,
      },
    });
    const vOf = (r: { variant?: string | null }) => r.variant ?? "normal";
    const priced = rows.filter((r) => r.priceMarket != null); // NFR-2: never a fabricated 0 point
    const variants = listVariants(priced.map((r) => ({ variant: vOf(r), priceMarket: r.priceMarket })));

    // Variant: explicit param, else the headline variant from current prices,
    // else the most common variant in history (ties → listVariants order).
    let variant = variantParam;
    if (!variant) {
      const current = await prisma.currentPrice.findMany({
        where: { cardId: card.id },
        select: { variant: true, type: true, condition: true, company: true, grade: true, priceMarket: true, priceLow: true },
      });
      variant = pickDefaultVariant(current);
      if (!variant) {
        const counts = new Map<string, number>();
        for (const r of priced) counts.set(vOf(r), (counts.get(vOf(r)) ?? 0) + 1);
        variant = variants.reduce<string | null>(
          (best, v) => (best == null || (counts.get(v) ?? 0) > (counts.get(best) ?? 0) ? v : best),
          null
        );
      }
    }

    const mine = priced.filter((r) => vOf(r) === variant);
    const isGraded = (r: (typeof mine)[number]) => r.type === "graded" && !!r.company && !!r.grade;

    // Raw: only the best-ranked raw condition present for this variant.
    const rawRows = mine.filter((r) => !isGraded(r));
    const bestRank = rawRows.reduce((m, r) => Math.min(m, condRank(r.condition)), Infinity);

    const raw: Point[] = [];
    const graded: Record<string, Point[]> = {};
    for (const r of mine) {
      const point = { date: r.recordedAt.toISOString().slice(0, 10), price: r.priceMarket as number };
      if (isGraded(r)) pushCollapsed((graded[`${r.company}|${r.grade}`] ??= []), point);
      else if (condRank(r.condition) === bestRank) pushCollapsed(raw, point);
    }

    const payload = HistoryResponseSchema.parse({ raw, graded, variants });
    // Only cache a NON-empty DEFAULT-variant result. A card with 0 real history
    // points is a transient state (enrich hasn't landed yet) — caching it would
    // mask the real series that arrives after first view (empty-cache poisoning).
    const isEmpty = payload.raw.length === 0 && Object.keys(payload.graded).length === 0;
    if (!isEmpty && !variantParam) {
      await cacheSetJson(cacheKey, payload, CACHE_TTL.cardHistory);
    }
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[cards/history] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(EMPTY, { headers: { "Cache-Control": "no-store" } });
  }
}
