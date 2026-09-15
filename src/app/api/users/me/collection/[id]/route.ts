/**
 * DELETE /api/users/me/collection/[id] — remove one card from the authenticated user's collection.
 */

import { NextResponse } from "next/server";
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
