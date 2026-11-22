/**
 * Distinct printing/variant options for a game (feeds the search Variant
 * filter + text-query inference). Read from the real `Card.printing` column
 * only — no printing data (per-printing catalog pull not applied) → [] and the
 * UI hides the filter (RULE 2). Redis read-through, fail-open, Zod re-parse
 * on read (RULES 1, 4). Raw spellings ("reverseHolofoil" / "reverse holofoil")
 * collapse into one option keyed by `variantKey`; `raw` keeps the exact stored
 * spellings so the search can use a cheap exact `printing IN (...)` (btree-able)
 * instead of many ILIKEs.
 */
import { z } from "zod";
import { prisma } from "@/lib/db";
import { RedisKeys, CACHE_TTL } from "@/lib/redis";
import { cacheGetJson, cacheSetJson } from "@/lib/utils/cache";
import { variantKey, variantDisplayLabel } from "@/lib/utils/card-variant";

export const VariantOptionsSchema = z.array(z.object({ value: z.string(), label: z.string(), raw: z.array(z.string()) }));
export type VariantOption = z.infer<typeof VariantOptionsSchema>[number];

export async function getVariantOptions(game: "pokemon" | "onepiece"): Promise<VariantOption[]> {
  const key = RedisKeys.cardVariantOptions(game);
  const cached = VariantOptionsSchema.safeParse(await cacheGetJson<unknown>(key));
  if (cached.success) return cached.data;
  try {
    const rows = await prisma.card.groupBy({
      by: ["printing"],
      where: { set: { externalId: { startsWith: `${game}-` } }, printing: { not: null } },
    });
    const byKey = new Map<string, string[]>();
    for (const r of rows) {
      const k = variantKey(r.printing ?? "");
      if (k && r.printing) byKey.set(k, [...(byKey.get(k) ?? []), r.printing]);
    }
    const out = [...byKey.keys()].sort().map((value) => ({ value, label: variantDisplayLabel(value), raw: byKey.get(value)! }));
    await cacheSetJson(key, out, CACHE_TTL.cardVariantOptions);
    return out;
  } catch (err) {
    console.warn("[variant-options] failed, returning empty:", err instanceof Error ? err.message : err);
    return [];
  }
}
