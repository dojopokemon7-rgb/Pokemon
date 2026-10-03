/**
 * GET /api/cards/[id]/population — population report for the detail page.
 *
 * PLAN CONSTRAINT (§4): population is Pokémon PSA-English ONLY (Scrydex public
 * coverage); BGS is unavailable and never fabricated. This GET is a pure READ of
 * STORED population — it performs no live, credit-consuming fetch. A real refresh
 * is a MANUAL, owner-approval-gated action (POST, below). Until a card has been
 * refreshed, `report` is null and the UI shows the fallback state (never
 * invented numbers).
 *
 * Always 200 (never 500) so the detail page renders regardless.
 */

import { NextResponse } from "next/server";
import {
  getStoredPopulationReport,
  BGS_POPULATION_SUPPORTED,
} from "@/lib/services/population.service";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;
    const report = await getStoredPopulationReport(id);
    return NextResponse.json(
      { report, bgsSupported: BGS_POPULATION_SUPPORTED },
      { headers: { "Cache-Control": "private, max-age=86400" } }
    );
  } catch (err) {
    console.error("[cards/population] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ report: null, bgsSupported: BGS_POPULATION_SUPPORTED }, { status: 200 });
  }
}
