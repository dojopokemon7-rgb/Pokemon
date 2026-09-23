/**
 * Backfill Card.tags[] — searchable keyword tags built from existing
 * card/set metadata, powering the multi-field search OR.
 *
 * Usage: npx tsx scripts/backfill-tags.ts
 *
 * Tags are built from the fields the schema actually stores today:
 *   - card.types    (Fire, Water, …)
 *   - card.rarity   (Rare Holo, Ultra Rare — split into words too)
 *   - card.number   (e.g. "4/102" and its parts)
 *   - set.name      (Obsidian Flames → obsidian, flames)
 *   - set.series    (Scarlet & Violet → scarlet, violet)
 *
 * The richer TCG-API fields the task mentions (artist, subtypes, ability /
 * attack names, flavor text) are NOT stored on our Card model — the seed
 * never persisted them — so they can't be tagged without a schema change +
 * full re-seed, which is out of scope here. `buildTags` is the single place
 * to extend when those columns are added.
 *
 * Idempotent: recomputes tags from current metadata each run, so re-running
 * just refreshes them.
 */

import { prisma } from "@/lib/db";
import { buildTags } from "@/lib/utils/card-tags";

async function main(): Promise<void> {
  const cards = await prisma.card.findMany({
    // Only rows still missing tags, so the backfill is resumable and a
    // re-run after an interruption finishes the remainder quickly.
    where: { tags: { isEmpty: true } },
    select: {
      id: true,
      rarity: true,
      types: true,
      number: true,
      set: { select: { name: true, series: true } },
    },
  });

  console.log(`\n🏷️  Backfilling tags for ${cards.length} card(s)…\n`);
  // Write in parallel chunks — serial updates over the Supabase pooler are
  // ~50-100ms each (hours for thousands of rows); chunked concurrency cuts
  // that to minutes while staying under the connection-pool limit.
  const CHUNK = 20;
  let updated = 0;
  for (let i = 0; i < cards.length; i += CHUNK) {
    const chunk = cards.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map((c) => prisma.card.update({ where: { id: c.id }, data: { tags: buildTags(c) } }))
    );
    updated += chunk.length;
    if (updated % 500 < CHUNK) console.log(`  …${updated} tagged`);
  }
  console.log(`\n🎉 Done — tagged ${updated} card(s).\n`);
}

main()
  .catch((err) => {
    console.error("backfill-tags failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
