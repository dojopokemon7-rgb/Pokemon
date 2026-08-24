/**
 * GET  /api/users/me/collection — fetch the authenticated user's collection.
 * POST /api/users/me/collection — add one or more cards to it.
 *
 * Uses requireAuth guard to enforce authentication on both.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/utils/auth-guard";
import { prisma } from "@/lib/db";

export async function GET(request: Request): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;

  const { session } = guard;
  const userId = session.user.id;

  try {
    const items = await prisma.userCollection.findMany({
      where: { userId },
      include: {
        card: {
          include: {
            set: true,
          },
        },
      },
      orderBy: {
        addedAt: "desc",
      },
    });

    return NextResponse.json({ items }, { status: 200 });
  } catch (error) {
    console.error("[api/users/me/collection] Error fetching collection:", error);
    return NextResponse.json(
      {
        error: "Internal Server Error",
        message: "Failed to fetch user collection",
      },
      { status: 500 }
    );
  }
}

// =============================================================
// POST — Add cards to the authenticated user's collection
// =============================================================
//
// Cards come from /api/cards/search or /api/cards/trending, so their
// identity (externalId/name/set/image/price) is already known client-
// side — the client re-sends that payload here rather than the server
// re-fetching it. This route is the *only* place that turns a search
// result into a persisted `Card` + `UserCollection` row; every "add
// this card" action in the app (search grid, multi-select, trending)
// funnels through this one endpoint.
//
// A card is looked up by `externalId` first: if it already exists
// (e.g. seeded via prisma/seed.ts, or added by another user before),
// we reuse that row and just refresh name/image/price. If not, we
// create it — this is how the local catalog organically grows as
// users add cards search never seeded.

const AddCardSchema = z.object({
  externalId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  setName: z.string().trim().optional(),
  imageUrl: z.string().url().optional(),
  rarity: z.string().optional(),
  types: z.array(z.string()).optional(),
  marketPrice: z.number().nullable().optional(),
  quantity: z.number().int().min(1).max(999).default(1),
  isFoil: z.boolean().default(false),
  condition: z.string().trim().optional(),
  // Price the user actually paid — defaults to the card's current
  // market price if omitted (a reasonable default, not a fabricated one).
  purchasePrice: z.number().nullable().optional(),
});

const AddCollectionRequestSchema = z.object({
  cards: z.array(AddCardSchema).min(1).max(50),
});

/** Derives an in-set card number the same way prisma/seed.ts does. */
function deriveCardNumber(externalId: string): string {
  const parts = externalId.split("-");
  return parts.length > 1 ? parts[parts.length - 1] : externalId;
}

/** Lowercases, strips non-alphanumerics, hyphenates — for a stable set key. */
function slugifySetName(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown-set";
}

export async function POST(request: Request): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;

  const { session } = guard;
  const userId = session.user.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Bad Request", message: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const parsed = AddCollectionRequestSchema.safeParse(body);
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

  const results: Array<{ externalId: string; ok: boolean; error?: string }> = [];

  for (const item of parsed.data.cards) {
    try {
      const setName = item.setName?.trim() || "Unknown Set";
      const setExternalId = `user-added-${slugifySetName(setName)}`;

      const cardSet = await prisma.cardSet.upsert({
        where: { externalId: setExternalId },
        update: { name: setName },
        create: { externalId: setExternalId, name: setName },
      });

      const card = await prisma.card.upsert({
        where: { externalId: item.externalId },
        update: {
          name: item.name,
          ...(item.rarity ? { rarity: item.rarity } : {}),
          ...(item.types ? { types: item.types } : {}),
          ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
          ...(item.marketPrice != null
            ? { marketPrice: item.marketPrice, lastPricedAt: new Date() }
            : {}),
        },
        create: {
          externalId: item.externalId,
          name: item.name,
          number: deriveCardNumber(item.externalId),
          rarity: item.rarity ?? "Unknown",
          types: item.types ?? [],
          imageUrl: item.imageUrl ?? null,
          marketPrice: item.marketPrice ?? null,
          lastPricedAt: item.marketPrice != null ? new Date() : null,
          setId: cardSet.id,
        },
      });

      const purchasePrice = item.purchasePrice ?? item.marketPrice ?? card.marketPrice ?? null;

      // @@unique([userId, cardId, isFoil]) — adding the same card+foil
      // combo again increments quantity instead of creating a duplicate row.
      await prisma.userCollection.upsert({
        where: {
          userId_cardId_isFoil: { userId, cardId: card.id, isFoil: item.isFoil },
        },
        update: {
          quantity: { increment: item.quantity },
          ...(item.condition ? { condition: item.condition } : {}),
        },
        create: {
          userId,
          cardId: card.id,
          quantity: item.quantity,
          isFoil: item.isFoil,
          condition: item.condition ?? null,
          purchasePrice,
        },
      });

      results.push({ externalId: item.externalId, ok: true });
    } catch (error) {
      console.error(
        `[api/users/me/collection] Failed to add card "${item.externalId}":`,
        error instanceof Error ? error.message : error
      );
      results.push({
        externalId: item.externalId,
        ok: false,
        error: "Could not add this card.",
      });
    }
  }

  const addedCount = results.filter((r) => r.ok).length;
  const allFailed = addedCount === 0;

  return NextResponse.json(
    { added: addedCount, total: results.length, results },
    { status: allFailed ? 500 : 200 }
  );
}
