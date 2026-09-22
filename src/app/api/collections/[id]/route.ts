/**
 * /api/collections/[id]
 *
 *   PATCH  → rename ({ name }) and/or update settings ({ isPrivate, typeTag })
 *   DELETE → delete the collection
 *
 * Auth required. Ownership is enforced in the service (every mutation is
 * scoped to the session user's id), so touching another user's collection
 * throws P2025 → mapped to 404 here (no id-existence leak).
 */

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/utils/auth-guard";
import {
  renameCollection,
  deleteCollection,
  updateCollectionSettings,
} from "@/lib/services/collection.service";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";

function notFound(): NextResponse {
  return NextResponse.json(
    { error: "Not Found", message: "Collection not found." },
    { status: 404 }
  );
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;
  const { id } = await params;
  const userId = guard.session.user.id;

  let body: { name?: unknown; isPrivate?: unknown; typeTag?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad Request", message: "Invalid JSON body." }, { status: 400 });
  }

  try {
    // A rename and a settings change can arrive together or separately.
    let result;
    if (typeof body.name === "string") {
      result = await renameCollection(userId, id, body.name);
    }
    if (body.isPrivate !== undefined || body.typeTag !== undefined) {
      result = await updateCollectionSettings(userId, id, {
        isPrivate: body.isPrivate as boolean | undefined,
        typeTag: body.typeTag as never,
      });
    }
    if (!result) {
      return NextResponse.json(
        { error: "Bad Request", message: "No updatable fields provided." },
        { status: 400 }
      );
    }
    return NextResponse.json({ data: result });
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        { error: "Validation Error", message: err.issues[0]?.message ?? "Invalid input." },
        { status: 400 }
      );
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === "P2025") return notFound();
      if (err.code === "P2002") {
        return NextResponse.json(
          { error: "Conflict", message: "You already have a collection with that name." },
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
    await deleteCollection(guard.session.user.id, id);
    return NextResponse.json({ data: { id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return notFound();
    }
    throw err;
  }
}
