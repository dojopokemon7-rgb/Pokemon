/**
 * DELETE /api/users/me/collection/[id] — remove one card from the authenticated user's collection.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/utils/auth-guard";
import { prisma } from "@/lib/db";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;

  const userId = guard.session.user.id;
  const { id } = await params;

  try {
    const deleted = await prisma.userCollection.deleteMany({
      where: {
        id,
        userId,
      },
    });

    if (deleted.count === 0) {
      return NextResponse.json(
        { error: "Not Found", message: "Collection item not found." },
        { status: 404 }
      );
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error("[api/users/me/collection/[id]] Error deleting collection item:", error);
    return NextResponse.json(
      { error: "Internal Server Error", message: "Failed to delete collection item" },
      { status: 500 }
    );
  }
}

const UpdateCollectionItemSchema = z.object({
  quantity: z.number().int().min(1).optional(),
  purchasePrice: z.number().nullable().optional(),
  condition: z.string().trim().nullable().optional(),
  collectionId: z.string().trim().nullable().optional(),
  // Collectr Mark as Sold feature
  isSold: z.boolean().optional(),
  soldPrice: z.number().nullable().optional(),
  soldQuantity: z.number().int().min(1).optional(),
  soldAt: z.string().optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

  const parsed = UpdateCollectionItemSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Bad Request", message: parsed.error.message }, { status: 400 });
  }

  try {
    const existing = await prisma.userCollection.findFirst({
      where: { id, userId },
      include: { card: true },
    });

    if (!existing) {
      return NextResponse.json({ error: "Not Found", message: "Item not found" }, { status: 404 });
    }

    const { isSold, soldPrice, soldQuantity, soldAt, purchasePrice, condition, collectionId, quantity } = parsed.data;

    // Handle Mark as Sold
    if (isSold === true) {
      const price = soldPrice ?? existing.card.marketPrice ?? 0;
      const saleDate = soldAt ? new Date(soldAt) : new Date();
      const qtyToSell = soldQuantity ?? existing.quantity;

      if (qtyToSell < existing.quantity) {
        // Partial sale: decrement existing active item
        await prisma.userCollection.update({
          where: { id: existing.id },
          data: { quantity: existing.quantity - qtyToSell },
        });

        // Create new sold record
        const soldItem = await prisma.userCollection.create({
          data: {
            userId,
            cardId: existing.cardId,
            quantity: qtyToSell,
            isFoil: existing.isFoil,
            condition: existing.condition,
            notes: existing.notes,
            purchasePrice: existing.purchasePrice,
            collectionId: existing.collectionId,
            isSold: true,
            soldPrice: price,
            soldAt: saleDate,
          },
        });

        return NextResponse.json({ ok: true, item: soldItem }, { status: 200 });
      } else {
        // Complete sale of this entry
        const updated = await prisma.userCollection.update({
          where: { id: existing.id },
          data: {
            isSold: true,
            soldPrice: price,
            soldAt: saleDate,
          },
        });

        return NextResponse.json({ ok: true, item: updated }, { status: 200 });
      }
    }

    // Handle Unsold / Revert to active
    if (isSold === false && existing.isSold) {
      const updated = await prisma.userCollection.update({
        where: { id: existing.id },
        data: {
          isSold: false,
          soldPrice: null,
          soldAt: null,
        },
      });
      return NextResponse.json({ ok: true, item: updated }, { status: 200 });
    }

    // General update
    const updated = await prisma.userCollection.update({
      where: { id: existing.id },
      data: {
        ...(quantity !== undefined ? { quantity } : {}),
        ...(purchasePrice !== undefined ? { purchasePrice } : {}),
        ...(condition !== undefined ? { condition } : {}),
        ...(collectionId !== undefined ? { collectionId } : {}),
        ...(soldPrice !== undefined ? { soldPrice } : {}),
        ...(soldAt !== undefined ? { soldAt: new Date(soldAt) } : {}),
      },
    });

    return NextResponse.json({ ok: true, item: updated }, { status: 200 });
  } catch (error) {
    console.error("[api/users/me/collection/[id]] Error updating item:", error);
    return NextResponse.json({ error: "Internal Server Error", message: "Failed to update item" }, { status: 500 });
  }
}
