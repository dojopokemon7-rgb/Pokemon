/**
 * POST /api/users/me/portfolio/refresh — ON-DEMAND, BATCHED, 24h price refresh
 * for the authenticated user's ACTIVE portfolio holdings.
 *
 * WHY this exists (client code-review decision, §4.5 of the security review):
 * portfolio prices must NOT be a week stale. Instead of refreshing all ~40-50k
 * catalog cards, we refresh ONLY the user's own active holdings, in a bounded
 * batch, when the user explicitly refreshes their portfolio.
 *
 * DIVISION OF RESPONSIBILITY (do not conflate with the enrich route):
 *   - This endpoint owns PORTFOLIO price freshness (24h), via the pricing
 *     service's own built-in 24h gate (SCRYDEX_STALE_MS on
 *     SyncLog(job="scrydex_history", cardId)).
 *   - The per-card on-view enrich route (`/api/cards/[id]/enrich`, STALE_MS 7d)
 *     is a SEPARATE concern — the card-DETAIL history+population weekly refresh.
 *     The 7-day enrich window does NOT contradict this 24h portfolio refresh.
 *
 * SPEND IS DOUBLE-BOUNDED:
 *   1. Credit gate (isScrydexLiveApproved): when live spend is NOT approved the
 *      whole batch is a safe no-op — 200 { refreshed:0, reason:"disabled" },
 *      zero HTTP, zero credits (AGENTS.md RULE 7 graceful 200).
 *   2. Per-card 24h gate inside pullAndStoreScrydexPrice: a card pulled within
 *      the last 24h is skipped (no HTTP, no credit) — so repeated portfolio
 *      refreshes within a day cost ZERO. We pass NO `force` so the gate stands.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/utils/auth-guard";
import { isScrydexLiveApproved } from "@/lib/services/scrydex-credit-gate";
import {
  pullAndStoreScrydexPrice,
  type ScrydexPullCard,
} from "@/lib/services/scrydex-pricing.service";
import { invalidateUserCaches } from "@/lib/utils/cache";

// Batched Scrydex pulls can exceed the default serverless timeout — same
// reasoning as the enrich route (Pro honours 60; Hobby caps at 60).
export const maxDuration = 60;

// ponytail: hard cap on cards refreshed per request. The review said "batches
// of hundreds"; 100 keeps one request comfortably inside maxDuration at ~5-wide
// concurrency. Ceiling: a user holding >100 distinct active cards gets only the
// first 100 refreshed this request. Upgrade path: paginate (cursor) or enqueue
// a background job that walks the rest.
const MAX_REFRESH_PER_REQUEST = 100;

// ponytail: small concurrency pool — fast enough (not fully sequential) without
// hammering Scrydex / the DB pool with 100 parallel pulls. Ceiling: a fixed
// width; upgrade to an adaptive/token-bucket limiter if Scrydex rate limits.
const CONCURRENCY = 5;

export async function POST(request: Request): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;
  const userId = guard.session.user.id;

  // Credit gate — a safe no-op when live spend is not approved (no HTTP, no
  // credits). Mirrors how the enrich route gates on-view spend.
  if (!(await isScrydexLiveApproved())) {
    return NextResponse.json(
      { refreshed: 0, skipped: 0, reason: "disabled" },
      { status: 200 }
    );
  }

  // ACTIVE holdings only (isSold:false), userId-scoped (RULE 5). A user can
  // hold the same card across multiple collections → dedupe by cardId.
  const holdings = await prisma.userCollection.findMany({
    where: { userId, isSold: false },
    select: {
      card: {
        select: {
          id: true,
          externalId: true,
          name: true,
          number: true,
          game: true,
          scrydexId: true,
          set: { select: { name: true } },
        },
      },
    },
  });

  const byCardId = new Map<string, ScrydexPullCard>();
  for (const h of holdings) {
    const c = h.card;
    if (!c || byCardId.has(c.id)) continue;
    byCardId.set(c.id, {
      id: c.id,
      externalId: c.externalId,
      name: c.name,
      number: c.number,
      game: c.game,
      scrydexId: c.scrydexId,
      setName: c.set?.name ?? null,
    });
  }
  const cards = [...byCardId.values()].slice(0, MAX_REFRESH_PER_REQUEST);

  let refreshed = 0;
  let skipped = 0;
  let failed = 0;

  // Bounded-concurrency worker pool over a shared cursor. Each pull is already
  // fail-open internally; the per-card try/catch here guarantees one card's
  // failure never aborts the batch (RULE 7).
  let cursor = 0;
  async function worker() {
    while (cursor < cards.length) {
      const card = cards[cursor++];
      try {
        // NO force — the built-in 24h gate skips cards priced in the last day,
        // so a repeated portfolio refresh within 24h spends nothing.
        const { pulled } = await pullAndStoreScrydexPrice(card);
        if (pulled) refreshed++;
        else skipped++;
      } catch {
        failed++;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, cards.length) }, worker)
  );

  // Bust the user's collection cache so the next portfolio GET re-reads the
  // fresh prices (best-effort / fail-open — a cache fault never fails the batch).
  await invalidateUserCaches(userId, ["collection", "dashboard"]);

  return NextResponse.json({ refreshed, skipped, failed }, { status: 200 });
}
