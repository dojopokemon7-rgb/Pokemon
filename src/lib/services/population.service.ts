/**
 * Population report data for the card detail page.
 *
 * PLAN CONSTRAINT (§1, §4): population is a Scrydex capability requested with
 * `include=pop_reports`, and Scrydex's PUBLIC coverage is **Pokémon PSA English
 * only** (docs/SCRYDEX_AUDIT.md). Therefore:
 *   - **BGS population is UNAVAILABLE** under documented coverage — we never
 *     present it as available and never fabricate BGS counts.
 *   - **PSA English population is CONDITIONAL** — shown only where Scrydex
 *     actually returns pop data for the card, and only on an explicit MANUAL
 *     refresh (never on page load / search / scheduled sync).
 *   - We NEVER invent population numbers. No reference/sample data. When no real
 *     data is available the caller renders a fallback state (plan: "if a provider
 *     has no value, the app must not invent one").
 *
 * The previous REFERENCE_POPULATION sample (incl. fabricated BGS counts) was
 * REMOVED for this reason.
 *
 * Live Scrydex population is a credit-consuming call (1 credit, `include=
 * pop_reports`), so the real fetch is OWNER-APPROVAL-GATED (scrydex-credit-gate)
 * and wired through the manual-refresh action — not performed here on read.
 */

export interface PopulationGrade {
  grade: string;
  count: number;
}

export interface PopulationCompany {
  company: "PSA";
  /** Language scope of the coverage; Scrydex public = English only. */
  language: "English";
  total: number;
  grades: PopulationGrade[];
}

export interface PopulationReport {
  /** Always "scrydex" when present — reference/fabricated data is not produced. */
  source: "scrydex";
  companies: PopulationCompany[];
  /** When the data was last refreshed (manual action). */
  refreshedAt: string;
}

/** Full grade ladder the UI renders (highest → Auth), per the design. */
const GRADE_LADDER = ["10", "9", "8", "7", "6", "5", "4", "3", "2", "1.5", "1", "Auth"] as const;

/**
 * Returns the STORED population report for a card, or null when none has been
 * refreshed. This is a pure read — it never performs a live credit-consuming
 * fetch. The manual-refresh action (owner-approval-gated) is what populates the
 * store; until then this returns null and the UI shows the fallback state.
 *
 * NOTE: a persistent population store is a follow-up (plan §4 keeps population
 * manual-only and out of the 24h price schedule). Until that store exists this
 * honestly returns null rather than fabricating — which is the correct,
 * non-inventing behaviour.
 */
export async function getStoredPopulationReport(
  _cardId: string
): Promise<PopulationReport | null> {
  // No fabricated fallback. BGS is never returned (unavailable coverage).
  // PSA English is returned only from real stored Scrydex data, which does not
  // exist until a manual, approved refresh persists it.
  void _cardId;
  return null;
}

/**
 * BGS population availability under current documented Scrydex coverage.
 * Exported so the UI can show an explicit "not available for BGS" state rather
 * than an empty grid that reads like "zero population".
 */
export const BGS_POPULATION_SUPPORTED = false as const;

export { GRADE_LADDER };
