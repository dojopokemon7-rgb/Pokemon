/**
 * GET /api/cards/filter-options?game=pokemon|onepiece
 *
 * Distinct set names + rarities for the Explore filter dropdowns, so they are
 * populated before any search. Public card route: HTTP 200 with empty arrays
 * on any error. Redis 24h read-through, fail-open, Zod re-parse on read.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { RedisKeys, CACHE_TTL } from "@/lib/redis";
import { cacheGetJson, cacheSetJson } from "@/lib/utils/cache";

const QuerySchema = z.object({ game: z.enum(["pokemon", "onepiece"]) });
const OptionsSchema = z.object({ sets: z.array(z.string()), rarities: z.array(z.string()) });

const clean = (v: (string | null)[]): string[] =>
  [...new Set(v.map((s) => (s ?? "").trim()).filter((s) => s && s.toLowerCase() !== "unknown"))].sort();

export async function GET(request: Request): Promise<NextResponse> {
  const parsed = QuerySchema.safeParse({
    game: new URL(request.url).searchParams.get("game") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Bad Request", message: "game must be pokemon or onepiece" }, { status: 400 });
  }
  const { game } = parsed.data;
  const key = RedisKeys.cardFilterOptions(game);
  const cached = OptionsSchema.safeParse(await cacheGetJson<unknown>(key));
  if (cached.success) return NextResponse.json(cached.data);

  try {
    const prefix = { startsWith: `${game}-` };
    const [sets, rarities] = await Promise.all([
      prisma.cardSet.findMany({ where: { externalId: prefix }, select: { name: true } }),
      prisma.card.findMany({
        where: { set: { externalId: prefix } },
        distinct: ["rarity"],
        select: { rarity: true },
      }),
    ]);
    const body = OptionsSchema.parse({
      sets: clean(sets.map((s) => s.name)),
      rarities: clean(rarities.map((r) => r.rarity)),
    });
    await cacheSetJson(key, body, CACHE_TTL.cardFilterOptions);
    return NextResponse.json(body);
  } catch (err) {
    console.warn("[filter-options] failed, returning empty:", err instanceof Error ? err.message : err);
    return NextResponse.json({ sets: [], rarities: [] });
  }
}
