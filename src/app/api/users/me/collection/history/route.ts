/**
 * GET /api/users/me/collection/history — per-collection value history for the
 * dashboard comparison chart.
 *
 *   ?collectionIds=<id,id,...|null|all>&range=1M|3M|1Y|ALL
 *   → { histories: { [collectionId]: [{ date, value }] } }
 *
 * Plan §6 (honest, ownership-aware): a lot contributes to a collection's value
 * ONLY within its ownership interval `[addedAt, soldAt)` — we never value a card
 * before it was added or after it was sold. Value uses the nearest REAL stored
 * price at/before each date (carry-forward); a lot with no real price yet simply
 * doesn't contribute (honest gap, never a fabricated $0). One series per
 * collection — never summed. The pure math lives in `buildCollectionSeries`.
 *
 * THIN caller: the ownership-scoped DB reads + timeline + series orchestration
 * live in `buildCollectionHistories` (collection-history.service.ts) so the
 * dashboard server component can SSR the SAME default-range histories from one
 * source of truth. This route only parses params, delegates, and keeps the
 * graceful empty-histories-on-error 200.
 */
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/utils/auth-guard";
import { buildCollectionHistories } from "@/lib/services/collection-history.service";

export async function GET(request: Request): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;
  const userId = guard.session.user.id;

  const { searchParams } = new URL(request.url);
  const collectionIdsParam = searchParams.get("collectionIds");
  const collectionIds = collectionIdsParam ? collectionIdsParam.split(",") : ["null"];
  const range = searchParams.get("range") || "1M";

  try {
    const histories = await buildCollectionHistories(userId, collectionIds, range);
    return NextResponse.json({ histories });
  } catch (error) {
    console.error("[api/users/me/collection/history] Error:", error);
    // Graceful: empty histories rather than a 500 so the chart renders its
    // "no price history yet" state.
    return NextResponse.json({ histories: {} }, { status: 200 });
  }
}
