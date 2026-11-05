/**
 * POST /api/users/me/collection/[id]/sell — record a sale of an owned lot.
 *
 * Plan §5:
 *   - Sell ALL or PART of an owned quantity. Inputs: quantity sold, GROSS price
 *     PER COPY, and a sale date (defaults to today, editable).
 *   - A partial sale SPLITS the row: the sold quantity moves to a NEW row with
 *     isSold=true (same collectionId → Sold section WITHIN the same collection,
 *     association preserved), the remainder stays active. Quantity is conserved.
 *   - A full sale flips the SAME row to isSold=true in place (preserving its id,
 *     addedAt, and provenance) — observable outcome byte-for-byte identical to
 *     today's full sale, leaving no active remainder.
 *   - The sold row stores GROSS proceeds for its quantity (grossPerCopy * qty)
 *     in soldPrice, the currency in soldCurrency, and copies the lot's cost
 *     basis provenance so realized P&L can be computed (or shown unresolved).
 *   - Ownership-scoped: `where: { id, userId }`; a foreign/unknown id → 404.
 *
 * CONCURRENCY (security remediation phase 1 — sale integrity):
 *   The quantity check and the quantity mutation are a SINGLE atomic DB op — a
 *   guarded conditional `updateMany` — on BOTH branches:
 *     - Partial: `where:{id,userId,isSold:false,quantity:{gte:soldQty}}`,
 *       `data:{quantity:{decrement:soldQty}}`.
 *     - Full:    `where:{id,userId,isSold:false,quantity:soldQty}` (still exactly
 *       this many, still active), `data:{isSold:true,soldPrice,soldCurrency,soldAt}`.
 *   The `WHERE` predicate is evaluated under the row's write lock, so two
 *   concurrent sells cannot both pass a stale snapshot and oversell — the
 *   loser's updateMany matches 0 rows → 409, having written nothing. For the
 *   partial branch the guarded decrement + the sold-row create run in ONE
 *   interactive `$transaction`, so a create failure rolls the decrement back.
 *   No `SELECT ... FOR UPDATE`, no isolation bump, no migration.
 *
 * Realized P&L itself is computed on read (portfolio stats) via the pure
 * portfolio-accounting helpers — this route only records the sale truthfully.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/utils/auth-guard";
import { prisma } from "@/lib/db";
import { invalidateUserCaches } from "@/lib/utils/cache";
import { redis } from "@/lib/redis";

const SellSchema = z.object({
  quantity: z.number().int().min(1),
  // .finite() mirrors the sibling [id]/route.ts money fields: z.number() alone
  // accepts Infinity, which would record a non-finite proceeds value. Reject it
  // (and any negative) with a 400 (RULE 4).
  grossPricePerCopy: z.number().finite().nonnegative(),
  // ISO date (YYYY-MM-DD) or full timestamp; defaults to now when omitted.
  soldAt: z.string().trim().optional(),
  currency: z.string().trim().optional(),
});

// Short-window retry dedupe (best-effort, Redis-optional per RULE 1). A SETNX
// over a key derived from the sale's identity rejects an accidental
// double-submit/network-retry for a few seconds. This is a UX guard, NOT the
// oversell defense — the guarded decrement below is what makes a retry safe
// (after a successful sale the quantity is already gone, so a replayed request
// simply misses the guard → 409). When Redis is down the SETNX throws and we
// fall through to the sale (the decrement still protects correctness).
//
// ponytail: fixed 10s window keyed by {user,lot,qty,price,date}. Ceiling — a
// legitimate identical re-sale of a REFILLED lot within 10s is rejected (429);
// a retry after >10s is caught only by the guarded decrement (safe, not a
// no-op). A durable idempotency key would need a schema column (out of scope —
// no migration); upgrade path = add `UserCollection.saleRequestId @unique`.
const IDEMPOTENCY_TTL_SECONDS = 10;
async function claimIdempotency(key: string): Promise<boolean> {
  try {
    // ioredis: SET key val NX EX ttl → "OK" when claimed, null when it already
    // exists (a duplicate in-flight/just-completed request).
    const res = await redis.set(key, "1", "EX", IDEMPOTENCY_TTL_SECONDS, "NX");
    return res === "OK";
  } catch {
    // Redis optional (RULE 1): an outage must never block a sale.
    return true;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;
  const userId = guard.session.user.id;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad Request", message: "Invalid JSON" }, { status: 400 });
  }

  const parsed = SellSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Bad Request", message: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 }
    );
  }
  const { quantity, grossPricePerCopy, soldAt, currency } = parsed.data;

  const saleDate = soldAt ? new Date(soldAt) : new Date();
  if (Number.isNaN(saleDate.getTime())) {
    return NextResponse.json({ error: "Bad Request", message: "Invalid soldAt date." }, { status: 400 });
  }

  // Ownership-scoped lookup → absent/foreign id becomes a 404 (no id-enumeration
  // leak). The snapshot is used to COPY provenance onto the sold row and to give
  // an honest fast-fail 400 on an obvious over-request; the AUTHORITATIVE
  // availability decision is the guarded decrement below, not this read.
  const lot = await prisma.userCollection.findFirst({
    where: { id, userId, isSold: false },
  });
  if (!lot) {
    return NextResponse.json({ error: "Not Found", message: "Owned lot not found." }, { status: 404 });
  }

  // Friendly fast-fail on an over-request against the snapshot. The DB guard is
  // the real enforcement; this keeps an honest over-ask a 400 (bad input) while
  // only a genuine race surfaces as a 409.
  if (quantity > lot.quantity) {
    return NextResponse.json(
      { error: "Bad Request", message: `Cannot sell ${quantity}; only ${lot.quantity} owned.` },
      { status: 400 }
    );
  }

  const soldCurrency = (currency || lot.costBasisCurrency || "USD").toUpperCase();
  const grossProceeds = grossPricePerCopy * quantity;
  const isFullSale = quantity === lot.quantity;

  // Best-effort retry dedupe (see claimIdempotency note). Key is derived from
  // the sale's identity so a replayed submit collides, but a genuinely new sale
  // (different qty/price/date) does not.
  const idemKey = `sell:idem:${userId}:${id}:${quantity}:${grossProceeds}:${saleDate.getTime()}`;
  const claimed = await claimIdempotency(idemKey);
  if (!claimed) {
    return NextResponse.json(
      { error: "Too Many Requests", message: "Duplicate sale request; please wait and retry." },
      { status: 429 }
    );
  }

  try {
    let soldRow;

    if (isFullSale) {
      // Full sale — guarded in-place flip. updateMany matches ONLY while the row
      // is still active AND still holds EXACTLY this quantity; a concurrent sale
      // that changed either makes count 0 → 409, nothing written. A single
      // statement is atomic on its own, so no $transaction wrapper is needed.
      const flip = await prisma.userCollection.updateMany({
        where: { id, userId, isSold: false, quantity },
        data: { isSold: true, soldPrice: grossProceeds, soldCurrency, soldAt: saleDate },
      });
      if (flip.count === 0) throw new GuardMissError();
      soldRow = await prisma.userCollection.findFirst({ where: { id, userId } });
    } else {
      // Partial sale — guarded decrement + sold-row create in ONE interactive
      // $transaction so a create failure rolls the decrement back. The guard
      // (quantity >= soldQty, still active) makes the check+decrement atomic;
      // count 0 means a concurrent sale consumed the stock → 409, nothing
      // written (the thrown sentinel rolls the tx back).
      soldRow = await prisma.$transaction(async (tx) => {
        const dec = await tx.userCollection.updateMany({
          where: { id, userId, isSold: false, quantity: { gte: quantity } },
          data: { quantity: { decrement: quantity } },
        });
        if (dec.count === 0) throw new GuardMissError();

        // Sold row carries the SAME collectionId + full cost-basis provenance so
        // realized P&L stays correct (or honestly unresolved). GROSS proceeds for
        // the sold quantity go in soldPrice.
        return tx.userCollection.create({
          data: {
            userId,
            cardId: lot.cardId,
            quantity,
            isFoil: lot.isFoil,
            condition: lot.condition,
            notes: lot.notes,
            purchasePrice: lot.purchasePrice,
            costBasisSource: lot.costBasisSource,
            costBasisCurrency: lot.costBasisCurrency,
            costBasisAttemptedAt: lot.costBasisAttemptedAt,
            collectionId: lot.collectionId, // Sold section WITHIN the same collection
            isSold: true,
            soldPrice: grossProceeds,
            soldCurrency,
            soldAt: saleDate,
          },
        });
      });
    }

    // Invalidate collection:{userId} + dashboard:{userId}. Best-effort, OUTSIDE
    // the tx: a cache failure must never roll back a committed sale (RULE 1).
    await invalidateUserCaches(userId, ["collection", "dashboard"]);
    return NextResponse.json({ ok: true, item: soldRow }, { status: 200 });
  } catch (err) {
    if (err instanceof GuardMissError) {
      return NextResponse.json(
        { error: "Conflict", message: "Quantity changed; please retry." },
        { status: 409 }
      );
    }
    console.error("[collection/sell] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Internal Server Error", message: "Failed to record sale." },
      { status: 500 }
    );
  }
}

/** Sentinel thrown inside the tx when the guarded decrement matches 0 rows, so
 * the transaction rolls back and the handler can map it to a 409. */
class GuardMissError extends Error {
  constructor() {
    super("sale guard miss");
    this.name = "GuardMissError";
  }
}
