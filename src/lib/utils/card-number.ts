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
