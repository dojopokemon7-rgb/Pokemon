/**
 * Pure core of scripts/reconcile-onepiece-sets.ts — isolated so the canonical
 * keeper rule is unit-testable with ZERO DB (AGENTS.md RULE 11: pure domain
 * logic lives in src/lib/utils and leaves one runnable check; mirrors the
 * revoke-admins.ts split).
 *
 * WHY this exists: two owner-run scripts ingested the SAME Scrydex One Piece
 * catalog but keyed CardSet.externalId off two different source fields —
 * `scripts/ingest-onepiece-catalog.ts` used the set NAME → `onepiece-<slug>`
 * (e.g. `onepiece-romance-dawn`), while `scripts/pull-full-catalog.ts` used the
 * Scrydex expansion id = the Bandai CODE → `onepiece-<CODE>` (e.g.
 * `onepiece-OP01`). Both survive under the `onepiece-` prefix, so every set has
 * up to three rows (plain slug, a "One Piece "-prefixed third-variant slug, and
 * the CODE row). The app reads sets by NAME, so the canonical row is the
 * NAME/slug one that holds the cards. This picks that keeper for one name group
 * and lists the losers to re-point then delete.
 */

/** One `onepiece-%` CardSet row, reduced to what the keeper rule needs. */
export interface OnePieceSetRow {
  externalId: string;
  name: string;
  cardCount: number;
}

export interface KeeperPlan {
  keeper: OnePieceSetRow;
  /** Every row in the group that is not the keeper. */
  losers: OnePieceSetRow[];
}

/**
 * A CODE-style One Piece set id: `onepiece-OP01` / `-ST01` / `-EB01` / `-PRB01`.
 * Case-insensitive — `pull-full-catalog.ts` preserves Scrydex `exp.id` casing
 * (usually uppercase) but test fixtures carry lowercase, so both are CODE rows.
 */
export function isCodeStyleOnePieceSetId(externalId: string): boolean {
  return /^onepiece-(OP|ST|EB|PRB)\d{2}$/i.test(externalId);
}

/**
 * A "third-variant" One Piece set id — Scrydex sometimes returns the expansion
 * name with a leading "One Piece ", which slugifies to `onepiece-one-piece-…`.
 * Ranks below the plain slug but above the CODE row.
 */
export function isThirdVariantOnePieceSetId(externalId: string): boolean {
  return externalId.startsWith("onepiece-one-piece-");
}

/** Precedence tier: lower number = preferred keeper. */
function keeperTier(externalId: string): number {
  if (isCodeStyleOnePieceSetId(externalId)) return 2; // CODE row — least preferred
  if (isThirdVariantOnePieceSetId(externalId)) return 1; // third-variant slug
  return 0; // plain slug — canonical
}

/**
 * Pick the canonical keeper for ONE normalized name group and list its losers.
 *
 * Rule (authoritative): plain-slug beats third-variant beats CODE row; WITHIN a
 * tier the HIGHEST cardCount wins, ties broken by externalId ascending (so the
 * choice is deterministic). A single-row group is its own keeper with no losers
 * — this is exactly the "name has only a CODE row → leave it" case and the §4C
 * genuine promo sets (unique names never form a >1 group), so neither is ever
 * touched. Throws on an empty group (programmer error — the caller groups real
 * rows).
 */
export function pickOnePieceSetKeeper(group: OnePieceSetRow[]): KeeperPlan {
  if (group.length === 0) {
    throw new Error("pickOnePieceSetKeeper: empty group (programmer error)");
  }

  const keeper = [...group].sort((a, b) => {
    const tierDiff = keeperTier(a.externalId) - keeperTier(b.externalId);
    if (tierDiff !== 0) return tierDiff; // prefer lower tier
    if (b.cardCount !== a.cardCount) return b.cardCount - a.cardCount; // then higher count
    return a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0; // then id asc
  })[0];

  const losers = group.filter((r) => r.externalId !== keeper.externalId);
  return { keeper, losers };
}
