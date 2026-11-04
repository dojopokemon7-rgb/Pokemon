/**
 * Pure helpers deriving analytics properties from a card's externalId —
 * reuses the app's existing signals (RULE: don't re-detect game/language ad
 * hoc at each call site). No fabrication: language is OMITTED when unknown.
 */
import { isOnePieceCode } from "@/lib/utils/card-number";

export type AnalyticsGame = "pokemon" | "one_piece";
export type AnalyticsLanguage = "jp" | "en";

/** "pokemon" | "one_piece" from the same Bandai-code check the write path uses. */
export function gameFromExternalId(externalId: string): AnalyticsGame {
  return isOnePieceCode(externalId) ? "one_piece" : "pokemon";
}

/**
 * "jp" when the externalId carries the app's existing "_ja-" marker (same rule
 * as GET /api/cards/search's language filter), "en" otherwise. Only call this
 * for Pokémon cards — One Piece ids carry no such marker and the app does not
 * claim to know their language, so callers should omit `language` for them.
 */
export function languageFromExternalId(externalId: string): AnalyticsLanguage {
  return externalId.includes("_ja-") ? "jp" : "en";
}

/** Props every card-scoped event shares: `game`, plus `language` only when the
 *  app really knows it (Pokémon via the "_ja-" marker; omitted for One Piece). */
export function cardBaseProps(externalId: string): {
  game: AnalyticsGame;
  language?: AnalyticsLanguage;
} {
  const game = gameFromExternalId(externalId);
  return game === "pokemon"
    ? { game, language: languageFromExternalId(externalId) }
    : { game };
}

/** The search page's game state ("onepiece") -> taxonomy value ("one_piece"). */
export function gameFromSearchState(game: string): AnalyticsGame {
  return game === "onepiece" ? "one_piece" : "pokemon";
}

/**
 * Which filter dimensions an apply actually changed to a NON-empty value
 * (clearing a filter is not "applying" one). Pure; order follows `overrides`.
 */
export function changedFilterTypes(
  current: Record<string, string>,
  overrides: Record<string, string | undefined>
): string[] {
  return Object.entries(overrides)
    .filter(([k, v]) => v !== undefined && v !== "" && v !== (current[k] ?? ""))
    .map(([k]) => k);
}