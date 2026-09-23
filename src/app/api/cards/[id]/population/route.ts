/**
 * GET /api/cards/[id]/population — population report for the detail page.
 *
 * PSA-primary with a reference fallback (see population.service.ts). Always
 * 200: returns `{ report }` or `{ report: null }` — never a 500 — so the
 * detail page renders regardless.
 */

import { NextResponse } from "next/server";
import { getPopulationReport } from "@/lib/services/population.service";

export async function GET(): Promise<NextResponse> {
  try {
    const report = await getPopulationReport();
    return NextResponse.json({ report }, { headers: { "Cache-Control": "private, max-age=86400" } });
  } catch (err) {
    console.error("[cards/population] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ report: null }, { status: 200 });
  }
}
