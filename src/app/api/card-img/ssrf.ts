/**
 * Shared SSRF guard for the Pokémon card-image proxies.
 *
 * Used by BOTH:
 *   - the `?u=<url>` proxy  (./route.ts)      — url comes from the client
 *   - the id-based proxy    (./[id]/route.ts) — url comes from the DB
 *
 * Keeping the allowlist + validation in ONE place guarantees the two routes
 * can never drift apart. The id-based route resolves its URL from the DB, but
 * STILL runs this check (defense in depth): a poisoned/legacy `Card.imageUrl`
 * must never let the server fetch an off-allowlist / internal target.
 */

// Hosts that actually serve Pokémon card art in this app (confirmed):
//   - images.scrydex.com  — the entire stored catalog (full-catalog pull;
//     e.g. https://images.scrydex.com/pokemon/mee-1/medium). Verified by
//     querying every POKEMON Card.imageUrl: 10000/10000 are this host.
//   - assets.tcgdex.net   — TCGdex live-search fallback adapter
//     (card.service.ts fetchTcgdex → `${image}/high.webp`).
//   - images.pokemontcg.io — Pokémon TCG API live-search fallback adapter
//     (card.service.ts fetchPokemonTcg → images.small/large).
// Exact-match Set — never a substring check (so `images.scrydex.com.evil.com`
// is rejected). MUST stay in sync with POKEMON_IMG_HOSTS in
// src/lib/utils/card-image.ts.
export const ALLOWED_POKEMON_IMG_HOSTS: ReadonlySet<string> = new Set([
  "images.scrydex.com",
  "assets.tcgdex.net",
  "images.pokemontcg.io",
]);

/**
 * Returns the parsed URL when `raw` is a well-formed https URL, with no
 * credentials, whose hostname EXACTLY matches an allowlisted Pokémon CDN host.
 * Returns null otherwise (malformed, http, userinfo, or off-allowlist host) —
 * the caller turns null into a 400. Redirects are handled by the fetch call
 * (`redirect: "manual"`), not here.
 */
export function assertAllowedPokemonImageHost(
  raw: string | null | undefined
): URL | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !ALLOWED_POKEMON_IMG_HOSTS.has(parsed.hostname)
  ) {
    return null;
  }
  return parsed;
}
