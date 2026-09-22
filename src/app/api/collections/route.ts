/**
 * /api/collections
 *
 *   GET  → list the authenticated user's collections
 *   POST → create a collection { name, isPrivate?, typeTag? }
 *
 * Auth required. Ownership is implicit — every query is scoped to the
 * session user, so a user only ever sees/creates their own collections.
 */

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/utils/auth-guard";
import { createCollection, listCollections } from "@/lib/services/collection.service";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";

export async function GET(request: Request): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;

  const collections = await listCollections(guard.session.user.id);
  return NextResponse.json({ data: collections }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad Request", message: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const collection = await createCollection(guard.session.user.id, body as never);
    return NextResponse.json({ data: collection }, { status: 201 });
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        { error: "Validation Error", message: err.issues[0]?.message ?? "Invalid input." },
        { status: 400 }
      );
    }
    // Unique-name conflict per user (@@unique([userId, name])).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json(
        { error: "Conflict", message: "You already have a collection with that name." },
        { status: 409 }
      );
    }
    throw err;
  }
}
