/**
 * Pure, game-gated derivation of the value stored in `Card.number`.
 *
 * Two card families store their collector number differently so that the
 * stored value equals what the scanner's recognizer parses off the card:
 *
 *  - One Piece: the FULL Bandai code (e.g. "OP01-064"). The recognizer parses
 *    the full set-serial code and `normalizeNumber` keeps the digit→digit
 *    hyphen ("op01-064"), so storing only the bare tail ("064") would make the
 *    +50 number signal never fire for ANY One Piece card.
 *  - Pokémon / other: the segment after the final hyphen ("base1-4" → "4"),
 *    preserving the historic behavior.
 *
 * These helpers are the single source of truth for both write paths
 * (prisma/seed.ts and the collection add route) — do not reintroduce a local
 * copy.
 */

/**
 * True when an externalId is a Bandai One Piece code (OP/ST/EB/PRB + digit),
 * e.g. "OP01-064". Pokémon ids like "base1-4" do not match.
 */
export function isOnePieceCode(externalId: string): boolean {
  return /^(OP|ST|EB|PRB)\d/i.test(externalId);
}

/**
 * The value to store in `Card.number`.
 *
 * One Piece: the FULL Bandai code (so it equals the recognizer's parsed,
 * normalized "op01-064"). Pokémon / other: the segment after the last hyphen
 * ("base1-4" → "4"). An id with no hyphen returns itself so `number` is never
 * empty.
 */
export function deriveStoredCardNumber(externalId: string, isOnePiece: boolean): string {
  if (isOnePiece) return externalId;
  const parts = externalId.split("-");
  return parts.length > 1 ? parts[parts.length - 1] : externalId;
}

/**
 * The name of the BASE printing for a per-printing re-model (design.md §4.1).
 *
 * Given a card's Scrydex `variants[].name` list, the base printing is the one
 * named "normal" (case-insensitive) if present, else the lexicographically
 * smallest name (localeCompare "en"). An empty name maps to "normal" so a
 * nameless variant is treated as the base. Order-independent: sorting a copy
 * means the same set of names always yields the same base, regardless of the
 * input array's order.
 */
export function baseVariantName(variantNames: string[]): string {
  const names = variantNames.map((n) => (n === "" ? "normal" : n));
  const normal = names.find((n) => n.toLowerCase() === "normal");
  if (normal) return normal;
  return [...names].sort((a, b) => a.localeCompare(b, "en"))[0];
}

/**
 * The per-printing externalId (design.md §4.1). The BASE printing keeps the
 * existing row's externalId verbatim; every non-base printing gets a stable
 * `${baseId}::${variantName}` composite key that rides the `externalId @unique`.
 */
export function printingExternalId(baseId: string, variantName: string, baseName: string): string {
  return variantName === baseName ? baseId : `${baseId}::${variantName}`;
}

/**
 * The printing VARIANT name encoded in a per-printing composite externalId —
 * the inverse of the non-base branch of `printingExternalId`. A composite id
 * is `${baseId}::${variantName}` (e.g. "base1-2::unlimitedShadowlessHolofoil"
 * → "unlimitedShadowlessHolofoil", "OP01-120::alt-art" → "alt-art"); a BASE id
 * with no `::` returns null (its default variant is derived elsewhere — e.g.
 * pickDefaultVariant over the stored prices). The suffix is the verbatim
 * Scrydex `variants[].name`, so this is the SAME token the write-side
 * `card.printing` scope uses — the read-side chart default and the write-side
 * history/price scope stay in lock-step. Rejoins any further `::` so a variant
 * that itself contains `::` round-trips unchanged.
 */
export function printingVariantFromId(externalId: string): string | null {
  return externalId.split("::").slice(1).join("::") || null;
}
