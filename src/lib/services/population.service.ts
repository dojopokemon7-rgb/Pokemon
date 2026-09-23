/**
 * Population report data for the card detail page.
 *
 * Source reality (verified against PSA docs + multiple 2026 sources):
 *   - The PSA *public* API (the key we have) is cert-verification only and
 *     has NO population endpoint. Real per-card pop data is only available
 *     via paid providers (PSA Marketplace Insights / PokeInvest / GemRate).
 *   - Our database has no population table either.
 *
 * So this module returns REFERENCE population data (the same shape the
 * detail page rendered before) as a graceful fallback, so the section shows
 * a grade breakdown "like it did before" rather than an empty state. The
 * `source` field is honest about where the numbers came from:
 *   - "psa"       → real PSA population (only when a real pop API is wired)
 *   - "reference" → sample reference data (current fallback)
 *
 * When a real population API is added, implement `fetchPsaPopulation()` to
 * return `source: "psa"` and this fallback is bypassed automatically.
 *
 * ponytail: reference (sample) pop data as fallback — a known corner cut.
 * Upgrade path: a paid population API (Marketplace Insights / GemRate),
 * then delete REFERENCE_POPULATION and return real per-card counts.
 */

export interface PopulationGrade {
  grade: string;
  count: number;
}

export interface PopulationCompany {
  company: "PSA" | "BGS";
  total: number;
  grades: PopulationGrade[];
}

export interface PopulationReport {
  source: "psa" | "reference";
  companies: PopulationCompany[];
}

/** Full grade ladder the UI renders (highest → Auth), per the design. */
const GRADE_LADDER = ["10", "9", "8", "7", "6", "5", "4", "3", "2", "1.5", "1", "Auth"] as const;

/** Sample reference distribution — the same profile the page showed before,
 *  expanded across the full grade ladder. Deterministic (not random) so the
 *  section is stable per render. */
const REFERENCE_POPULATION: PopulationReport = {
  source: "reference",
  companies: [
    {
      company: "PSA",
      total: 983,
      grades: [
        { grade: "10", count: 945 },
        { grade: "9", count: 28 },
        { grade: "8", count: 4 },
        { grade: "7", count: 3 },
        { grade: "6", count: 1 },
        { grade: "5", count: 1 },
        { grade: "4", count: 0 },
        { grade: "3", count: 0 },
        { grade: "2", count: 0 },
        { grade: "1.5", count: 0 },
        { grade: "1", count: 1 },
        { grade: "Auth", count: 0 },
      ],
    },
    {
      company: "BGS",
      total: 468,
      grades: [
        { grade: "10", count: 367 },
        { grade: "9", count: 92 },
        { grade: "8", count: 5 },
        { grade: "7", count: 2 },
        { grade: "6", count: 1 },
        { grade: "5", count: 1 },
        { grade: "4", count: 0 },
        { grade: "3", count: 0 },
        { grade: "2", count: 0 },
        { grade: "1.5", count: 0 },
        { grade: "1", count: 0 },
        { grade: "Auth", count: 0 },
      ],
    },
  ],
};

/**
 * Attempts to fetch REAL population data. The PSA public API has no pop
 * endpoint, so this always returns null today — it's the seam where a paid
 * population API gets wired in later. Never throws.
 */
async function fetchPsaPopulation(): Promise<PopulationReport | null> {
  // No real population source is available on the configured PSA key.
  // TODO: when a paid pop API (Marketplace Insights / GemRate) is added,
  // fetch per-card counts here and return { source: "psa", companies }.
  return null;
}

/**
 * Resolves a population report: PSA primary, reference fallback. Only
 * returns null when BOTH are empty (which, with the reference fallback
 * present, means never — the caller still guards for it).
 */
export async function getPopulationReport(): Promise<PopulationReport | null> {
  try {
    const psa = await fetchPsaPopulation();
    if (psa && psa.companies.some((c) => c.total > 0)) return psa;
  } catch {
    // fall through to reference
  }
  return REFERENCE_POPULATION;
}

export { GRADE_LADDER };
