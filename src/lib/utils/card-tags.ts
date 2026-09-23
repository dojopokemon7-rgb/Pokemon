/**
 * Card search tags — shared helper used by the seed, the daily sync cron
 * (sync-cards.service), and the one-off backfill (scripts/backfill-tags),
 * so every card-write path tags cards identically and search-by-tag works
 * for both seeded and cron-imported cards.
 *
 * Tags are built from the fields the Card/CardSet models actually store:
 * card types, rarity, card number, and set name/series. Richer TCG-API
 * fields (artist, subtypes, ability/attack names, flavor text) aren't
 * persisted on our schema, so extend `buildTags` here if those columns
 * are ever added.
 */

/** Split a phrase into lowercased word tokens (drop 1-char noise). */
function words(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((w) => w.length >= 2);
}

/** Build the deduped tag list for one card from its (and its set's) metadata. */
export function buildTags(card: {
  rarity: string | null;
  types: string[];
  number: string;
  set: { name: string; series: string | null } | null;
}): string[] {
  const tags = new Set<string>();
  for (const t of card.types) tags.add(t.toLowerCase());
  for (const w of words(card.rarity)) tags.add(w);
  for (const w of words(card.number)) tags.add(w);
  for (const w of words(card.set?.name)) tags.add(w);
  for (const w of words(card.set?.series)) tags.add(w);
  return [...tags];
}
