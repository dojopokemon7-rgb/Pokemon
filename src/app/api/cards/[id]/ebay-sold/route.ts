/**
 * GET /api/cards/[id]/ebay-sold — real eBay SOLD records for a card, powering
 * the "Recent Sales" section on the card detail page.
 *
 * SOURCE (Part D): a PURE POSTGRES READ of the SoldListing table. These are
 * REAL SOLD records (each carries `soldAt`) persisted by the owner-approval-
 * gated single writer `pullAndStoreSoldListings`. We NEVER fall back to active
 * listings and NEVER fabricate sales — a card with no stored sales returns an
 * empty list and the UI shows "No recent sales found".
 *
 * NO CREDIT GATE ON READ: the previous implementation was Redis-only +
 * credit-gated, so sold records could never display locally (gate is DENY) and
 * vanished after the 24h Redis TTL. Reading from Postgres makes the display
 * gate-free and durable. The only live, credit-consuming path is the writer,
 * which is NOT invoked here.
 *
 * `[id]` is the EXTERNAL card id OR the internal cuid — we resolve either to
 * the internal Card.id, then read SoldListing rows ordered soldAt desc
 * (nulls last) limited to 8.
 *
 * CACHE (RULE 1 — OPTIONAL, FAIL-OPEN): a short-TTL (120s) read-through on the
 * NEW `soldRows` key keyed by the internal card id, so a burst of detail-page
 * views doesn't re-query every time. Postgres is the SOURCE OF TRUTH; a Redis
 * miss/fault just re-reads Postgres. The legacy `ebaySold` key is NO LONGER
 * read or written here — it ages out on its own TTL.
 *
 * Always 200 so the detail page renders regardless (unknown card / no rows →
 * { listings: [] }).
 *
 * POST /api/cards/[id]/ebay-sold — BUTTON-GATED pull of real SOLD records.
 * Triggered only by the detail page's "Load recent sales" button (never on
 * mount). Gated by the SAME on-view allowance flag SCRYDEX_ONVIEW_ENABLED as
 * the enrich route: when OFF it is an honest no-op (`{ pulled:false }`,
 * NO call to pullAndStoreSoldListings) so the UI shows "No recent sales found"
 * — never an error. When ON, it runs the credit-gated single writer fail-open
 * (a throw → `{ pulled:false }`, never a 5xx). The writer best-effort busts the
 * soldRows cache so the subsequent GET re-reads the fresh set.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { RedisKeys, CACHE_TTL } from "@/lib/redis";
import { cacheGetJson, cacheSetJson } from "@/lib/utils/cache";
import { requireAuth } from "@/lib/utils/auth-guard";
import { enforceRateLimit, creditTier } from "@/lib/utils/rate-limit";
import { isScrydexOnViewApproved } from "@/lib/services/scrydex-credit-gate";
import { pullAndStoreSoldListings } from "@/lib/services/scrydex-pricing.service";

interface SoldRecord {
  itemId: string;
  source: string | null;
  title: string | null;
  price: number | null;
  currency: string | null;
  soldAt: string | null;
  grade: string | null;
  company: string | null;
  url: string | null;
}

// RULE 4: the exact shape this route caches (an array of SoldRecord). Used ONLY
// to re-validate the Redis blob on READ — a stale OLD-shape blob fails this and
// is treated as a miss (fall through to the live Postgres read), never served.
const SoldRowsCacheSchema = z.array(
  z.object({
    itemId: z.string(),
    source: z.string().nullable(),
    title: z.string().nullable(),
    price: z.number().nullable(),
    currency: z.string().nullable(),
    soldAt: z.string().nullable(),
    grade: z.string().nullable(),
    company: z.string().nullable(),
    url: z.string().nullable(),
  })
);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  // Resolve the route param ([id] = externalId OR internal cuid) to Card.id.
  // Unknown card → honest empty (never a 4xx; the detail page still renders).
  const card = await prisma.card.findFirst({
    where: { OR: [{ externalId: id }, { id }] },
    select: { id: true },
  });
  if (!card) {
    return NextResponse.json({ listings: [] }, { status: 200 });
  }

  const cacheKey = RedisKeys.soldRows(card.id);

  // Short-TTL read-through (best-effort, fail-open → re-read Postgres on miss).
  const rawCached = await cacheGetJson<unknown>(cacheKey);
  if (rawCached != null) {
    // RULE 4: re-parse on read; a stale OLD-shape blob is treated as a miss.
    const parsed = SoldRowsCacheSchema.safeParse(rawCached);
    if (parsed.success) {
      return NextResponse.json({ listings: parsed.data, source: "cache" }, { status: 200 });
    }
  }

  // Pure Postgres read — newest sales first, nulls last, capped at 8.
  const rows = await prisma.soldListing.findMany({
    where: { cardId: card.id },
    orderBy: { soldAt: { sort: "desc", nulls: "last" } },
    take: 8,
    select: {
      itemId: true,
      source: true,
      title: true,
      price: true,
      currency: true,
      soldAt: true,
      grade: true,
      company: true,
      url: true,
    },
  });

  const listings: SoldRecord[] = rows.map((r) => ({
    itemId: r.itemId,
    source: r.source ?? null,
    title: r.title ?? null,
    price: typeof r.price === "number" ? r.price : null,
    currency: r.currency ?? null,
    soldAt: r.soldAt ? r.soldAt.toISOString() : null,
    grade: r.grade ?? null,
    company: r.company ?? null,
    url: r.url ?? null,
  }));

  // Best-effort cache write (fail-open) — a miss next time just re-reads.
  await cacheSetJson(cacheKey, listings, CACHE_TTL.soldRows);

  return NextResponse.json({ listings, source: "db" }, { status: 200 });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  // SECURITY: this BUTTON-GATED POST can trigger a live Scrydex credit spend
  // (sold-listings pull, ~5cr). It is called ONLY from the authenticated
  // card-detail page's "Load recent sales" button, so require a session —
  // otherwise an anonymous caller could iterate catalog ids and drain credits.
  // The GET above stays PUBLIC (pure Postgres read, no spend; AGENTS.md rule 7).
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;

  // Rate-limit by user BEFORE the on-view gate + credit-gated sold-listings
  // pull — caps a client iterating card ids to drain sold-listings credits.
  const limited = await enforceRateLimit(request, creditTier(), {
    kind: "user",
    id: guard.session.user.id,
  });
  if (limited) return limited;

  const { id } = await params;

  // ON-VIEW allowance OFF → honest no-op, NO pull call (asserted by test).
  // The GET read still renders stored rows / "No recent sales found".
  if (!(await isScrydexOnViewApproved())) {
    return NextResponse.json({ pulled: false, reason: "disabled" }, { status: 200 });
  }

  // Allowance ON → run the credit-gated single writer fail-open: a thrown
  // ScrydexCreditsNotApproved / transient fault must NOT 5xx (AGENTS.md rule 7).
  try {
    const { stored } = await pullAndStoreSoldListings(id);
    return NextResponse.json({ pulled: true, stored }, { status: 200 });
  } catch {
    return NextResponse.json({ pulled: false, reason: "unavailable" }, { status: 200 });
  }
}
