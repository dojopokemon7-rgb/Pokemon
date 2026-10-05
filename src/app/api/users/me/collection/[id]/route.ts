/**
 * DELETE /api/users/me/collection/[id] — remove one card from the authenticated user's collection.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAuth } from "@/lib/utils/auth-guard";
import { prisma } from "@/lib/db";
import { invalidateUserCaches } from "@/lib/utils/cache";

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

    // Invalidate collection:{userId} + dashboard:{userId} + collections:{userId}
    // (the per-collection bucket counts change on a remove). Best-effort.
    await invalidateUserCaches(userId, ["collection", "dashboard", "collections"]);
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

    // Handle Mark as Sold.
    // NOTE: the primary sale path is POST .../[id]/sell (gross-per-copy, partial
    // splits, provenance). This PATCH branch is kept for the legacy UI control
    // but must NOT fabricate a sale price: if no soldPrice is given and there is
    // no market value to fall back to, we refuse rather than record a $0 sale.
    if (isSold === true) {
      const price = soldPrice ?? existing.card.marketPrice ?? null;
      if (price == null) {
        return NextResponse.json(
          { error: "Bad Request", message: "A sale price is required (no market value to default to)." },
          { status: 400 }
        );
      }
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

        // Invalidate collection:{userId} + dashboard:{userId}. Best-effort.
        await invalidateUserCaches(userId, ["collection", "dashboard"]);
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

        // Invalidate collection:{userId} + dashboard:{userId}. Best-effort.
        await invalidateUserCaches(userId, ["collection", "dashboard"]);
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
      // Invalidate collection:{userId} + dashboard:{userId}. Best-effort.
      await invalidateUserCaches(userId, ["collection", "dashboard"]);
      return NextResponse.json({ ok: true, item: updated }, { status: 200 });
    }

    // General update (this is a RE-FILE path when collectionId changes).
    // F-#8: the FK only checks existence, so verify a non-null target
    // collectionId belongs to the user before writing it (cross-user attach
    // guard). Miss → 404, no existence leak, identical to a nonexistent id.
    if (collectionId != null) {
      const owned = await prisma.collection.findFirst({ where: { id: collectionId, userId } });
      if (!owned) {
        return NextResponse.json(
          { error: "Not Found", message: "Collection not found" },
          { status: 404 }
        );
      }
    }

    try {
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

      // Invalidate collection:{userId} + dashboard:{userId}. Best-effort.
      await invalidateUserCaches(userId, ["collection", "dashboard"]);
      return NextResponse.json({ ok: true, item: updated }, { status: 200 });
    } catch (e) {
      // F-#8: a re-file/edit that collides with an existing variant in the
      // target collection trips `uc_variant_coalesced` → P2002. Reject with 409
      // (consistent with the want-list move 409) rather than a surprising silent
      // merge on a user-initiated single-item edit, or a raw 500.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002" &&
        String((e.meta as { target?: unknown })?.target ?? "").includes("uc_variant_coalesced")
      ) {
        return NextResponse.json(
          { error: "Conflict", message: "That variant is already in the target collection" },
          { status: 409 }
        );
      }
      throw e; // any other error → the existing generic 500 catch
    }
  } catch (error) {
    console.error("[api/users/me/collection/[id]] Error updating item:", error);
    return NextResponse.json({ error: "Internal Server Error", message: "Failed to update item" }, { status: 500 });
  }
}
