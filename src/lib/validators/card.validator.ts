/**
 * Card Validation Schemas (Zod)
 *
 * Every external API (TCGdex, Pokémon TCG, Scrydex, TCG Price Lookup,
 * tcgcsv.com) returns a *different* JSON shape. Rather than letting
 * that untyped data flow through our service layer, we coerce each
 * response into a single, strict {@link NormalizedCard} structure.
 *
 * This file owns the canonical "contract" between:
 *   - The external API adapters (producers) in `card.service.ts`
 *   - The `/api/cards/search` route handler (consumer)
 *   - Redis (the cache stores exactly this shape)
 *
 * @module card-validator
 */

import { z } from "zod";

// =============================================================
// Normalized Card Schema
// =============================================================

/**
 * A single card normalized into our internal shape.
 *
 * Fields are intentionally `string`-based (e.g. `hp` is a string, not a
 * number) because different APIs report these inconsistently — some as
 * numbers, some as strings, some absent. We stringify at the adapter
 * boundary so downstream code never has to guess.
 *
 * - `id`        Stable identifier from the source API (used as cache key + dedupe key).
 * - `name`      Human-readable card name.
 * - `setImage`  The set the card belongs to (set name or set code).
 * - `rarity`    Rarity string (e.g. "Rare Holo", "Common"). Falls back to "Unknown".
 * - `hp`        Hit points, or `null` when the API doesn't report one (energy/trainer cards).
 * - `types`     Array of card types (e.g. ["Fire"]). Empty array when unknown.
 * - `imageUrl`  URL to the card image. Absolute (`https://…`) for
 *   externally-hosted art; relative (`/api/…`) for images that must
 *   route through our same-origin proxy — e.g. One Piece art from
 *   Bandai, which is served with
 *   `Cross-Origin-Resource-Policy: same-site` and cannot be embedded
 *   directly from a different origin.
 * - `marketPrice` Real market price in USD (e.g. TCGplayer "market" price
 *   from the Pokémon TCG API's `tcgplayer.prices` block), or `null` when
 *   the source doesn't report pricing. Never fabricated — UI must render
 *   a "—" placeholder rather than inventing a number when this is null.
 */
export const NormalizedCardSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  setImage: z.string(),
  rarity: z.string(),
  hp: z.string().nullable(),
  types: z.array(z.string()),
  imageUrl: z
    .string()
    .refine(
      (v) => /^https?:\/\//.test(v) || v.startsWith("/"),
      "imageUrl must be an absolute URL or a same-origin path starting with '/'"
    ),
  marketPrice: z.number().nullable().default(null),
});

/**
 * TypeScript type inferred from {@link NormalizedCardSchema}.
 * Import this (not the schema) into route handlers and services.
 */
export type NormalizedCard = z.infer<typeof NormalizedCardSchema>;

// =============================================================
// Normalized Search Response Schema
// =============================================================

/**
 * The envelope returned by every successful search.
 *
 * - `cards`  The normalized results. May be empty (all APIs returned no matches).
 * - `source` Which API produced the data, e.g. `"tcgdex"`, `"pokemon-tcg"`,
 *   `"scrydex-pokemon"`, `"cache"`. This is invaluable for debugging the
 *   fallback chain from the terminal logs.
 */
export const NormalizedSearchResponseSchema = z.object({
  cards: z.array(NormalizedCardSchema),
  source: z.string(),
});

/**
 * TypeScript type inferred from {@link NormalizedSearchResponseSchema}.
 */
export type NormalizedSearchResponse = z.infer<
  typeof NormalizedSearchResponseSchema
>;

/**
 * Helper that parses + validates an unknown payload into a
 * {@link NormalizedSearchResponse}. Throws a `ZodError` on invalid input,
 * which the fallback executor treats as a task failure.
 *
 * @param data - Raw, untyped object from an external API or cache.
 * @returns The validated {@link NormalizedSearchResponse}.
 */
export function parseSearchResponse(
  data: unknown
): NormalizedSearchResponse {
  return NormalizedSearchResponseSchema.parse(data);
}
