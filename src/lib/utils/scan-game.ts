import { z } from "zod";

/**
 * Scanner game context (client-safe). Mirrors scan-language.ts. Unlike
 * language, `game` is load-bearing: it scopes the recognize/search catalog to
 * either Pokémon (`pokemon-*` sets) or One Piece (`onepiece-*` sets). A One
 * Piece card scanned as Pokémon can never match (findings E1), so the scanner
 * sends the user's chosen game on every recognize/search call.
 */
export const ScanGameSchema = z.enum(["pokemon", "onepiece"]).default("pokemon");
export type ScanGame = z.infer<typeof ScanGameSchema>;

export const SCAN_GAME_STORAGE_KEY = "dojo:scan-game";

/** Stored game, or "pokemon" when missing/corrupt/storage unavailable. */
export function readScanGame(): ScanGame {
  try {
    const r = ScanGameSchema.safeParse(localStorage.getItem(SCAN_GAME_STORAGE_KEY) ?? undefined);
    return r.success ? r.data : "pokemon";
  } catch {
    return "pokemon";
  }
}

export function writeScanGame(game: ScanGame): void {
  try {
    localStorage.setItem(SCAN_GAME_STORAGE_KEY, game);
  } catch {
    /* storage blocked (private mode / quota) — preference just isn't persisted */
  }
}
