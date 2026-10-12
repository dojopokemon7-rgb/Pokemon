import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { RedisKeys, CACHE_TTL } from "@/lib/redis";
import { cacheGetJson, cacheSetJson } from "@/lib/utils/cache";
import { VariantImagesReadSchema } from "@/lib/utils/card-image";

// RULE 4: the exact shape this route caches. Used ONLY to re-validate the Redis
// blob on READ — a stale OLD-shape blob fails this and is treated as a miss
// (fall through to the live Prisma read), never served. `variantImages` is
// REQUIRED-nullable (NOT optional): a blob cached before the alt-art change
// lacks the key and MUST fail safeParse → cache MISS → live Prisma re-read, so
// the fresh per-variant image map is picked up. Reuses the ONE shared schema
// from card-image.ts so the stored shape never drifts between reader and route.
const PricesCacheSchema = z.object({
  prices: z.array(z.unknown()),
  weeklyChangePct: z.number().nullable(),
  variantImages: VariantImagesReadSchema.nullable(),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: externalId } = await params;

  // USER-AGNOSTIC, DB-read-only cache keyed by externalId (RULE 3 — `[id]` is
  // the catalog external id). No Scrydex call here, so no credit impact. A
  // Redis fault falls through to the live Prisma read.
  const cacheKey = RedisKeys.cardPrices(externalId);
  const rawCached = await cacheGetJson<unknown>(cacheKey);
  if (rawCached != null) {
    const parsed = PricesCacheSchema.safeParse(rawCached);
    if (parsed.success) {
      return NextResponse.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
    }
    // parse miss (stale OLD-shape blob) → fall through to the live read.
  }

  try {
    const card = await prisma.card.findUnique({
      where: { externalId },
      include: {
        // Deterministic order: the client picks headline/chips from these rows,
        // and an unordered read made multi-variant cards flip between variants.
        currentPrices: {
          orderBy: [
            { variant: "asc" },
            { type: "asc" },
            { condition: "asc" },
            { company: "asc" },
            { grade: "asc" },
          ],
        },
      },
    });

    if (!card) {
      // NFR-4: public card route — 200 + empty payload on unknown/err, never 4xx/5xx (UI renders "—").
      const empty = { prices: [], weeklyChangePct: null, variantImages: null };
      // Cache the empty result too (unknown externalId legitimately empty),
      // kept short by the same TTL.
      await cacheSetJson(cacheKey, empty, CACHE_TTL.cardPrices);
      return NextResponse.json(empty, { headers: { "Cache-Control": "no-store" } });
    }

    // weeklyChangePct is the REAL stored 7-day % change (Scrydex trends.days_7,
    // written by pullAndStoreScrydexPrice). Null until a priced pull runs — the
    // detail header then renders "—", never a fabricated number (AGENTS.md #2).
    // variantImages: the One Piece per-variant image map (null for Pokémon /
    // un-backfilled cards). The detail hero resolves the SELECTED variant's art
    // from it (card-image.onePieceVariantImageUrl); the scalar column comes back
    // in the findUnique without changing `include`.
    const payload = {
      prices: card.currentPrices,
      weeklyChangePct: card.weeklyChangePct ?? null,
      variantImages: card.variantImages ?? null,
    };
    await cacheSetJson(cacheKey, payload, CACHE_TTL.cardPrices);
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[cards/prices] failed:", err instanceof Error ? err.message : err);
    // NFR-4: public card route — 200 + empty payload on unknown/err, never 4xx/5xx (UI renders "—").
    return NextResponse.json(
      { prices: [], weeklyChangePct: null, variantImages: null },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
}
