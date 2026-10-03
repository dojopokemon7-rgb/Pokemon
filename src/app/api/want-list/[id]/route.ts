/**
 * /api/want-list/[id]
 *   PATCH { intent }  → move the item to a different tab (atomic intent change)
 *   DELETE            → remove the item
 * Auth required; ownership enforced in the service (P2025 → 404).
 */

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/utils/auth-guard";
import { moveWantListItem, removeWantListItem } from "@/lib/services/want-list.service";
import { MoveWantListSchema } from "@/lib/validators/want-list.validator";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { invalidateUserCaches } from "@/lib/utils/cache";

function notFound(): NextResponse {
  return NextResponse.json({ error: "Not Found", message: "Want-list item not found." }, { status: 404 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad Request", message: "Invalid JSON body." }, { status: 400 });
  }

  // F-#8: parse the WHOLE body — a move may re-scope the collection as well as
  // change the intent.
  const parsed = MoveWantListSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation Error", message: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 }
    );
  }

  const userId = guard.session.user.id;
  try {
    // Cross-user guard: a non-null target collectionId must belong to the user
    // (the FK only checks existence). Miss → 404, no existence leak.
    if (parsed.data.collectionId != null) {
      const owned = await prisma.collection.findFirst({
        where: { id: parsed.data.collectionId, userId },
      });
      if (!owned) return notFound();
    }
    const item = await moveWantListItem(userId, id, parsed.data);
    // A move changes TWO intent lists (source + target), so drop the whole
    // wantlist:{userId}:* family + dashboard:{userId}. Best-effort.
    await invalidateUserCaches(userId, ["wantlist", "dashboard"]);
    return NextResponse.json({ data: item });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === "P2025") return notFound();
      // Already in the target tab (unique on userId+cardId+intent).
      if (err.code === "P2002") {
        return NextResponse.json(
          { error: "Conflict", message: "That card is already in the target list." },
          { status: 409 }
        );
      }
    }
    throw err;
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;
  const { id } = await params;

  try {
    await removeWantListItem(guard.session.user.id, id);
    // Invalidate the wantlist:{userId}:* family + dashboard:{userId}. Best-effort.
    await invalidateUserCaches(guard.session.user.id, ["wantlist", "dashboard"]);
    return NextResponse.json({ data: { id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return notFound();
    }
    throw err;
  }
}
