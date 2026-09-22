/**
 * F-18 — Backfill Card.marketPrice for Pokémon cards that have no price yet.
 *
 * The card sync left ~1170 Pokémon cards with a null marketPrice, so the
 * search tiles correctly show "—". This one-shot backfill asks the real
 * Pokémon TCG API for the current TCGplayer "market" price and writes it to
 * Card.marketPrice (+ lastPricedAt).
 *
 * Usage (env-file is REQUIRED — the API key lives in .env and a bare `tsx`
 * run does NOT load it, so every request would be rate-limited to 5xx):
 *   npx tsx --env-file=.env scripts/backfill-pokemon-prices.ts
 *
 * Strategy — one BULK query per set, not one request per card:
 *   The API id is "<setId>-<number>" (e.g. "me3-8"). We group the null cards
 *   by setId and fetch each set's prices in a single
 *     GET /v2/cards?q=set.id:<setId>&select=id,tcgplayer&pageSize=250
 *   call. That's ~167 requests instead of 1170+, and it never hangs 40s on a
 *   card the API has no entry for.
 *
 * Reality check (why some cards stay "—"):
 *   The API only has a TCGplayer "market" price for cards TCGplayer has
 *   priced. Brand-new sets (e.g. "Perfect Order"/me3, "Pitch Black"/me5) come
 *   back with a tcgplayer block that has only a `url` and no `prices` — 0/124
 *   priced. Pokémon TCG *Pocket* sets (A1-*, B1a-*, P-A…) aren't in this API
 *   at all. Those cards correctly remain "—"; we never fabricate a number.
 *
 * The API flaps between 200 and 500/502 under load, so each set fetch retries
 * with backoff. Safe to re-run: it only ever looks at still-null cards.
 */

import { prisma } from "@/lib/db";

const BASE = "https://api.pokemontcg.io/v2";
const MAX_ATTEMPTS = 6;
const THROTTLE_MS = 300; // between sets, to be a good API citizen
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** API id is "<setId>-<number>"; the setId is everything before the last dash. */
function setIdOf(externalId: string): string {
  const dash = externalId.lastIndexOf("-");
  return dash > 0 ? externalId.slice(0, dash) : externalId;
}

/** First present, positive TCGplayer "market" price across variant map. */
function pickMarket(prices?: Record<string, { market?: number | null } | undefined>): number | null {
  if (!prices) return null;
  for (const v of Object.values(prices)) {
    const m = v?.market;
    if (typeof m === "number" && Number.isFinite(m) && m > 0) return m;
  }
  return null;
}

interface ApiCard {
  id: string;
  tcgplayer?: { prices?: Record<string, { market?: number | null }> } | null;
}

/** Bulk-fetch one set's price map: { "me3-8": 12.34, ... }. Retries on 5xx. */
async function fetchSetPrices(setId: string): Promise<Map<string, number>> {
  const key = process.env.POKEMON_TCG_API_KEY;
  const url = `${BASE}/cards?q=set.id:${encodeURIComponent(setId)}&select=id,tcgplayer&pageSize=250`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { headers: key ? { "X-Api-Key": key } : {} });
      if (res.ok) {
        const json = (await res.json()) as { data?: ApiCard[] };
        const out = new Map<string, number>();
        for (const c of json.data ?? []) {
          const m = pickMarket(c.tcgplayer?.prices ?? undefined);
          if (m != null) out.set(c.id, m);
        }
        return out;
      }
    } catch {
      /* network/timeout — fall through to retry */
    }
    if (attempt < MAX_ATTEMPTS) await sleep(attempt * 800); // 0.8s,1.6s,2.4s…
  }
  return new Map(); // gave up — treat whole set as unpriced this run
}

async function main(): Promise<void> {
  const cards = await prisma.card.findMany({
    where: { marketPrice: null, set: { externalId: { startsWith: "pokemon-" } } },
    select: { id: true, externalId: true },
  });

  // Group null cards by API setId.
  const bySet = new Map<string, { id: string; externalId: string }[]>();
  for (const c of cards) {
    const sid = setIdOf(c.externalId);
    let group = bySet.get(sid);
    if (!group) bySet.set(sid, (group = []));
    group.push(c);
  }

  console.log(
    `\n💰 Backfilling ${cards.length} null-priced Pokémon card(s) across ${bySet.size} set(s)…\n`
  );

  let updated = 0;
  let missing = 0;
  let setNo = 0;

  for (const [setId, group] of bySet) {
    setNo += 1;
    const prices = await fetchSetPrices(setId);
    let hit = 0;
    for (const card of group) {
      const price = prices.get(card.externalId);
      if (price == null) {
        missing += 1;
        continue; // no API price — stays "—", no fabrication
      }
      await prisma.card.update({
        where: { id: card.id },
        data: { marketPrice: price, lastPricedAt: new Date() },
      });
      updated += 1;
      hit += 1;
    }
    console.log(
      `  [${String(setNo).padStart(3)}/${bySet.size}] ${setId.padEnd(12)} priced ${hit}/${group.length}`
    );
    await sleep(THROTTLE_MS);
  }

  console.log(
    `\n🎉 Done — ${updated} card(s) priced, ${missing} left as "—" (no API price).\n`
  );
}

main()
  .catch((err) => {
    console.error("backfill-pokemon-prices failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
