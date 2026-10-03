/**
 * POST /api/users/me/collection/[id]/sell — record a sale of an owned lot.
 *
 * Plan §5:
 *   - Sell ALL or PART of an owned quantity. Inputs: quantity sold, GROSS price
 *     PER COPY, and a sale date (defaults to today, editable).
 *   - A partial sale SPLITS the row: the sold quantity moves to a NEW row with
 *     isSold=true (same collectionId → Sold section WITHIN the same collection,
 *     association preserved), the remainder stays active. Quantity is conserved.
 *   - The sold row stores GROSS proceeds for its quantity (grossPerCopy * qty)
 *     in soldPrice, the currency in soldCurrency, and copies the lot's cost
 *     basis provenance so realized P&L can be computed (or shown unresolved).
 *   - Ownership-scoped: `where: { id, userId }`; a foreign/unknown id → 404.
 *
 * Realized P&L itself is computed on read (portfolio stats) via the pure
 * portfolio-accounting helpers — this route only records the sale truthfully.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/utils/auth-guard";
import { prisma } from "@/lib/db";

const SellSchema = z.object({
  quantity: z.number().int().min(1),
  grossPricePerCopy: z.number().min(0),
  // ISO date (YYYY-MM-DD) or full timestamp; defaults to now when omitted.
  soldAt: z.string().trim().optional(),
  currency: z.string().trim().optional(),
});

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

  // Ownership-scoped lookup → P2025/absent becomes a 404 (no id-enumeration leak).
  const lot = await prisma.userCollection.findFirst({
    where: { id, userId, isSold: false },
  });
  if (!lot) {
    return NextResponse.json({ error: "Not Found", message: "Owned lot not found." }, { status: 404 });
  }

  if (quantity > lot.quantity) {
    return NextResponse.json(
      { error: "Bad Request", message: `Cannot sell ${quantity}; only ${lot.quantity} owned.` },
      { status: 400 }
    );
  }

  const saleDate = soldAt ? new Date(soldAt) : new Date();
  if (Number.isNaN(saleDate.getTime())) {
    return NextResponse.json({ error: "Bad Request", message: "Invalid soldAt date." }, { status: 400 });
  }
  const soldCurrency = (currency || lot.costBasisCurrency || "USD").toUpperCase();
  const grossProceeds = grossPricePerCopy * quantity;

  try {
    if (quantity === lot.quantity) {
      // Full sale — flip the existing row to sold (keeps collectionId).
      const updated = await prisma.userCollection.update({
        where: { id: lot.id },
        data: {
          isSold: true,
          soldPrice: grossProceeds,
          soldCurrency,
          soldAt: saleDate,
        },
      });
      return NextResponse.json({ ok: true, item: updated }, { status: 200 });
    }

    // Partial sale — split the row atomically: decrement the active lot and
    // create a sold row carrying the SAME collectionId + cost-basis provenance.
    const [, soldRow] = await prisma.$transaction([
      prisma.userCollection.update({
        where: { id: lot.id },
        data: { quantity: lot.quantity - quantity },
      }),
      prisma.userCollection.create({
        data: {
          userId,
          cardId: lot.cardId,
          quantity,
          isFoil: lot.isFoil,
          condition: lot.condition,
          notes: lot.notes,
          // Preserve cost-basis provenance so realized P&L is correct (or
          // honestly unresolved when the lot never had a resolved basis).
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
      }),
    ]);

    return NextResponse.json({ ok: true, item: soldRow }, { status: 200 });
  } catch (err) {
    console.error("[collection/sell] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Internal Server Error", message: "Failed to record sale." },
      { status: 500 }
    );
  }
}
