/**
 * Shared set-key helper — the single source of truth for how a set NAME is
 * turned into the stable `CardSet.externalId` key.
 *
 * Before this file, the `slugify` logic was copied privately in `prisma/seed.ts`
 * (`upsertCard` builds `${game}-${slugify(setName)}`) and again in the
 * collection-add route (a `user-added-*` variant, left alone — different prefix,
 * out of scope). Extracting the ONE slug implementation here lets the seed and
 * the One Piece catalog ingest share it without a third copy.
 *
 * The seed's One Piece output is unchanged by construction: for `game="onepiece"`
 * the key it already produced is `onepiece-<slug>`, which is exactly what
 * `onePieceSetExternalId` returns.
 */

/** Lowercases, strips non-alphanumerics, and hyphenates for a stable set key. */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown-set";
}

/**
 * The `CardSet.externalId` for a One Piece set, derived from its NAME via the
 * same `onepiece-<slug>` convention the seed already uses — NOT the Bandai set
 * code. Reuse this; do not invent a new set-id scheme.
 */
export function onePieceSetExternalId(setName: string): string {
  return `onepiece-${slugify(setName)}`;
}
