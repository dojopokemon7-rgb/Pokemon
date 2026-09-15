/**
 * GET    /api/users/me/favorites — list the authenticated user's favorites.
 * POST   /api/users/me/favorites — favorite a card (idempotent).
 * DELETE /api/users/me/favorites — unfavorite a card.
 *
 * Favorites are keyed by the card's `externalId` (the identity the
 * search/trending grids expose), so the client sends that rather than
 * the internal DB id. If the card isn't in the local catalog yet (a
 * user favoriting straight from a fresh search result), we upsert a
 * minimal Card row first — same pattern the collection POST uses — so
 * the favorite always references a real card.
 *
 * All three verbs require an authenticated session.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/utils/auth-guard";
import { prisma } from "@/lib/db";

// ── GET — list favorites (newest first) ───────────────────────────
export async function GET(request: Request): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;

  const userId = guard.session.user.id;

  try {
    const favorites = await prisma.favorite.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        cardId: true,
        createdAt: true,
        card: {
          select: {
            id: true,
            externalId: true,
            name: true,
            rarity: true,
            imageUrl: true,
            imageUrlHi: true,
            marketPrice: true,
            set: { select: { name: true } },
          },
        },
      },
    });

    return NextResponse.json({ favorites }, { status: 200 });
  } catch (error) {
    console.error("[api/users/me/favorites] GET failed:", error);
    return NextResponse.json(
      { error: "Internal Server Error", message: "Failed to load favorites." },
      { status: 500 }
    );
  }
}

// ── Shared payload — favoriting carries enough to create the card if
// it isn't in the catalog yet (same fields the collection POST takes). ─
const FavoriteSchema = z.object({
  externalId: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  setName: z.string().trim().optional(),
  imageUrl: z.string().url().optional().or(z.literal("")),
  marketPrice: z.number().nullable().optional(),
});

/** Derives an in-set card number the same way the collection route does. */
function deriveCardNumber(externalId: string): string {
  const parts = externalId.split("-");
  return parts.length > 1 ? parts[parts.length - 1] : externalId;
}

function slugifySetName(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown-set";
}

// ── POST — favorite a card (idempotent) ───────────────────────────
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;

  const userId = guard.session.user.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Bad Request", message: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const parsed = FavoriteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Bad Request",
        message: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
      { status: 400 }
    );
  }

  const item = parsed.data;

  try {
    // Resolve the card by externalId; create a minimal row if missing
    // (favoriting a fresh search result the catalog hasn't seen yet).
    let card = await prisma.card.findUnique({
      where: { externalId: item.externalId },
      select: { id: true },
    });

    if (!card) {
      const setName = item.setName?.trim() || "Unknown Set";
      const setExternalId = `user-added-${slugifySetName(setName)}`;
      const cardSet = await prisma.cardSet.upsert({
        where: { externalId: setExternalId },
        update: { name: setName },
        create: { externalId: setExternalId, name: setName },
      });
      card = await prisma.card.create({
        data: {
          externalId: item.externalId,
          name: item.name ?? item.externalId,
          number: deriveCardNumber(item.externalId),
          rarity: "Unknown",
          types: [],
          imageUrl: item.imageUrl || null,
          marketPrice: item.marketPrice ?? null,
          lastPricedAt: item.marketPrice != null ? new Date() : null,
          setId: cardSet.id,
        },
        select: { id: true },
      });
    }

    // Idempotent: starring an already-favorited card is a no-op.
    await prisma.favorite.upsert({
      where: { userId_cardId: { userId, cardId: card.id } },
      update: {},
      create: { userId, cardId: card.id },
    });

    return NextResponse.json({ ok: true, cardId: card.id }, { status: 200 });
  } catch (error) {
    console.error("[api/users/me/favorites] POST failed:", error);
    return NextResponse.json(
      { error: "Internal Server Error", message: "Could not favorite this card." },
      { status: 500 }
    );
  }
}

// ── DELETE — unfavorite a card (by externalId in the JSON body) ────
const UnfavoriteSchema = z.object({ externalId: z.string().trim().min(1) });

export async function DELETE(request: Request): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;

  const userId = guard.session.user.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Bad Request", message: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const parsed = UnfavoriteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Bad Request", message: "`externalId` is required." },
      { status: 400 }
    );
  }

  try {
    const card = await prisma.card.findUnique({
      where: { externalId: parsed.data.externalId },
      select: { id: true },
    });

    // No card = nothing to unfavorite; treat as success (idempotent).
    if (card) {
      await prisma.favorite.deleteMany({ where: { userId, cardId: card.id } });
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error("[api/users/me/favorites] DELETE failed:", error);
    return NextResponse.json(
      { error: "Internal Server Error", message: "Could not remove this favorite." },
      { status: 500 }
    );
  }
}
