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
 *
 * The persistent PopulationReport store NOW EXISTS (prisma/schema.prisma). This
 * module reads it; the credit-gated pullAndStorePopulation
 * (scrydex-pricing.service.ts) is the ONLY writer. This read never performs a
 * live credit-consuming fetch — it is a pure Prisma read (zero credits).
 */
import { prisma } from "@/lib/db";
import { z } from "zod";

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

// RULE 4: re-parse the stored JSON blob on read; a malformed / legacy blob is
// treated as "no data" (null), never crashes or renders junk.
const StoredGradesSchema = z.array(z.object({ grade: z.string(), count: z.number() }));

/**
 * Returns the STORED population report for a card, or null when none has been
 * refreshed. This is a pure Prisma read — it never performs a live
 * credit-consuming fetch (zero credits). The manual-refresh action
 * (owner-approval-gated pullAndStorePopulation) is what populates the store;
 * until a row exists this returns null and the UI shows the honest fallback.
 *
 * BGS is NEVER present in the result (unavailable coverage). PSA English is
 * returned only from real stored Scrydex data — never fabricated.
 */
export async function getStoredPopulationReport(
  cardIdOrExternalId: string
): Promise<PopulationReport | null> {
  // RULE 3: the route passes the route [id] (externalId). Resolve to Card.id
  // (the FK the store is keyed by). Also accept a raw Card.id (OR), matching
  // the ebay-sold route's `OR: [{ externalId }, { id }]` lookup, so any caller
  // that passes a cuid still finds the row.
  const card = await prisma.card.findFirst({
    where: { OR: [{ externalId: cardIdOrExternalId }, { id: cardIdOrExternalId }] },
    select: { id: true },
  });
  if (!card) return null;

  const row = await prisma.populationReport.findUnique({
    where: {
      cardId_source_company_language: {
        cardId: card.id,
        source: "scrydex",
        company: "PSA",
        language: "English",
      },
    },
  });
  if (!row) return null;

  const parsed = StoredGradesSchema.safeParse(row.grades);
  if (!parsed.success) return null;

  return {
    source: "scrydex",
    companies: [
      {
        company: "PSA",
        language: "English",
        total: row.total,
        grades: parsed.data,
      },
    ],
    refreshedAt: row.refreshedAt.toISOString(),
  };
}

/**
 * BGS population availability under current documented Scrydex coverage.
 * Exported so the UI can show an explicit "not available for BGS" state rather
 * than an empty grid that reads like "zero population".
 */
export const BGS_POPULATION_SUPPORTED = false as const;

export { GRADE_LADDER };
