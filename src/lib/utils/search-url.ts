/**
 * audit 02 F-A — pure URL builders for the Search/Explore page (no React, no
 * window). The search page commits navigation from several paths (new search,
 * sort change, set/rarity/graded/price/hasPrice/language filter change, game
 * switch, and the /search/multi links). Those paths used to each hand-build a
 * URL, and the new-search / game-switch / multi-link ones only wrote q+game —
 * silently dropping every active filter. Centralizing the URL shape here gives
 * ONE source of truth so every path preserves filters identically, and keeps
 * the logic unit-testable (a page.tsx may export ONLY its default component —
 * AGENTS.md NEXT.JS PAGE EXPORT GUARD, same rationale as list-controls.ts).
 *
 * Mirrors EXACTLY what applyFilters emits today: q -> 'q', game -> 'game', the
 * filter keys by their own names, and sort -> 'sort' only when non-default
 * ('trending' is the default and is omitted so default URLs stay clean).
 */

/** Every param the search page can carry on its URL. */
export interface SearchUrlParams {
  q?: string | null;
  game?: string | null;
  set?: string | null;
  rarity?: string | null;
  graded?: string | null;
  minPrice?: string | null;
  maxPrice?: string | null;
  hasPrice?: string | null;
  language?: string | null;
  /** View sort; omitted when it equals the default 'trending'. */
  sort?: string | null;
}

/**
 * Build the querystring (no leading `?`, no `/search`) for the search page,
 * omitting empty/undefined values and dropping sort when it is the default
 * 'trending'. Shared by buildSearchUrl and buildSearchQueryParams.
 */
function buildParams(params: SearchUrlParams, includeSort: boolean): URLSearchParams {
  const out = new URLSearchParams();
  if (params.q) out.set("q", params.q);
  if (params.game) out.set("game", params.game);
  if (params.set) out.set("set", params.set);
  if (params.rarity) out.set("rarity", params.rarity);
  if (params.graded) out.set("graded", params.graded);
  if (params.minPrice) out.set("minPrice", params.minPrice);
  if (params.maxPrice) out.set("maxPrice", params.maxPrice);
  if (params.hasPrice) out.set("hasPrice", params.hasPrice);
  if (params.language) out.set("language", params.language);
  // 'trending' is the default view sort — omit it so default URLs stay clean.
  if (includeSort && params.sort && params.sort !== "trending") out.set("sort", params.sort);
  return out;
}

/**
 * Return a `/search?...` path from the given params. Empty/undefined values are
 * omitted and sort is dropped when it equals 'trending'. With no params this
 * returns the bare `/search` (the trending view).
 */
export function buildSearchUrl(params: SearchUrlParams): string {
  const qs = buildParams(params, true).toString();
  return qs ? `/search?${qs}` : "/search";
}

/**
 * Return just the querystring (no leading `/search?`) for the /search/multi
 * links. Multi does NOT take a sort, so sort is never emitted here — only
 * q + game + the preserved filters ride along.
 */
export function buildSearchQueryParams(params: SearchUrlParams): string {
  return buildParams(params, false).toString();
}

/**
 * The filter set to carry across a Pokémon <-> One Piece game switch.
 *
 * KEEP game-agnostic filters (minPrice, maxPrice, hasPrice, graded, language)
 * plus q + sort; DROP the per-game ones (set, rarity). `set` and `rarity` are
 * per-game catalog attributes — a Base Set / Common value cannot apply across
 * franchises, so carrying them to the other game would yield zero matches —
 * while price/hasPrice/graded/language are universal and should persist.
 */
export function gameSwitchFilters(current: SearchUrlParams, nextGame: string): SearchUrlParams {
  return {
    q: current.q,
    game: nextGame,
    // game-agnostic — preserved across the switch
    minPrice: current.minPrice,
    maxPrice: current.maxPrice,
    hasPrice: current.hasPrice,
    graded: current.graded,
    language: current.language,
    sort: current.sort,
    // set + rarity intentionally dropped (per-game catalog attributes)
  };
}
