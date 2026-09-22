/**
 * /api/want-list/[id]
 *   PATCH { intent }  → move the item to a different tab (atomic intent change)
 *   DELETE            → remove the item
 * Auth required; ownership enforced in the service (P2025 → 404).
 */

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/utils/auth-guard";
import { moveWantListItem, removeWantListItem } from "@/lib/services/want-list.service";
import { WantIntentEnum } from "@/lib/validators/want-list.validator";
import { Prisma } from "@prisma/client";

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

  let body: { intent?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad Request", message: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = WantIntentEnum.safeParse(body.intent);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation Error", message: "intent must be BUY, SELL, or TRADE." },
      { status: 400 }
    );
  }

  try {
    const item = await moveWantListItem(guard.session.user.id, id, parsed.data);
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
    return NextResponse.json({ data: { id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return notFound();
    }
    throw err;
  }
}
