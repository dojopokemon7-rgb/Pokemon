/**
 * Backfill CLEAN One Piece card images (replace watermarked "SAMPLE" scans).
 *
 * Every One Piece Card.imageUrl currently points at a watermarked source —
 * either TCGplayer CDN (relayed by apitcg) or Bandai's own CDN
 * (en.onepiece-cardgame.com) — both of which stamp a "SAMPLE" overlay.
 * This one-shot script finds those cards and, for each, asks the licensed
 * clean-image chain (TCG Collector → Cardmarket, see card-image.server.ts)
 * for a non-watermarked URL and UPDATEs Card.imageUrl.
 *
 * Usage (env-file REQUIRED so the API keys load):
 *   npx tsx --env-file=.env scripts/backfill-images.ts
 *
 * IMPORTANT — this needs a licensed key to actually clean images:
 *   With no TCGCOLLECTOR_API_KEY (or CARDMARKET_APP_TOKEN) configured, the
 *   resolver has no clean source to pull from and returns null for every
 *   card. The script then reports "0 updated, N had no clean source" and
 *   leaves the existing (watermarked) URLs untouched — it never fabricates a
 *   URL or blanks a card. Provision the key and re-run; it's idempotent and
 *   only ever looks at cards still on a watermarked source.
 *
 * Safe to re-run: it re-selects the watermarked set each time.
 */

import { prisma } from "@/lib/db";
import { resolveOnePieceCleanImage } from "@/lib/utils/card-image.server";

const CONCURRENCY = 5; // parallel resolver calls — polite to upstream
const chunk = <T>(a: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/** A URL that still points at a known watermarked One Piece source. */
function isWatermarkedSource(url: string | null | undefined): boolean {
  if (!url) return false;
  return (
    url.includes("tcgplayer-cdn.tcgplayer.com") ||
    url.includes("onepiece-cardgame.com") ||
    url.includes("/api/one-piece-img/")
  );
}

async function main(): Promise<void> {
  const cards = await prisma.card.findMany({
    where: { set: { externalId: { startsWith: "onepiece-" } } },
    select: { id: true, externalId: true, imageUrl: true, imageUrlHi: true },
  });

  const dirty = cards.filter(
    (c) => isWatermarkedSource(c.imageUrl) || isWatermarkedSource(c.imageUrlHi)
  );

  console.log(
    `\n🖼️  ${dirty.length}/${cards.length} One Piece card(s) on a watermarked source. Resolving clean images…\n`
  );

  let updated = 0;
  let noSource = 0;

  for (const batch of chunk(dirty, CONCURRENCY)) {
    const results = await Promise.all(
      batch.map(async (c) => ({ card: c, clean: await resolveOnePieceCleanImage(c.externalId) }))
    );
    for (const { card, clean } of results) {
      if (!clean) {
        noSource += 1;
        continue;
      }
      await prisma.card.update({
        where: { id: card.id },
        data: { imageUrl: clean, imageUrlHi: clean },
      });
      updated += 1;
      console.log(`  ✅ ${card.externalId.padEnd(12)} → ${clean}`);
    }
  }

  console.log(
    `\n🎉 Done — ${updated} image(s) cleaned, ${noSource} had no clean source available` +
      (noSource > 0 && updated === 0
        ? `\n   (No TCGCOLLECTOR_API_KEY / CARDMARKET_APP_TOKEN configured — add one and re-run to pull clean art.)`
        : "") +
      "\n"
  );
}

main()
  .catch((err) => {
    console.error("backfill-images failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
