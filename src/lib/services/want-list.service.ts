/**
 * Want List Service (F-07).
 *
 * CRUD for a user's Buy/Sell/Trade wishlist. Ownership is enforced by
 * scoping every mutation's `where` to the acting `userId`; a foreign id
 * throws P2025 (mapped to 404 at the route) rather than leaking existence.
 */

import { prisma } from "@/lib/db";
import {
  AddWantListSchema,
  MoveWantListSchema,
  type AddWantListInput,
  type WantIntent,
} from "@/lib/validators/want-list.validator";

/**
 * Lists a user's want-list items, optionally filtered to one intent tab.
 *
 * `WantListItem.cardId` holds the EXTERNAL card id (e.g. "base1-4"), not
 * a FK to Card, so we resolve the display fields (name + image) with a
 * single `Card` lookup keyed by `externalId` and merge them in. Cards not
 * in the local catalog fall back to `name: null` / `imageUrl: null`; the
 * UI then shows the raw id, so an unknown card never breaks the list.
 */
export async function listWantList(userId: string, intent?: WantIntent) {
  const items = await prisma.wantListItem.findMany({
    where: { userId, ...(intent ? { intent } : {}) },
    orderBy: { createdAt: "desc" },
  });

  if (items.length === 0) return [];

  const cards = await prisma.card.findMany({
    where: { externalId: { in: items.map((i) => i.cardId) } },
    select: { externalId: true, name: true, imageUrl: true },
  });
  const byExternalId = new Map(cards.map((c) => [c.externalId, c]));

  return items.map((item) => {
    const card = byExternalId.get(item.cardId);
    return {
      ...item,
      name: card?.name ?? null,
      imageUrl: card?.imageUrl ?? null,
    };
  });
}

/** Adds a card to a want-list tab. Idempotent on (userId, cardId, intent). */
export async function addWantListItem(userId: string, input: AddWantListInput) {
  const { cardId, intent } = AddWantListSchema.parse(input);
  // upsert so re-adding the same card+intent is a no-op, not a unique-violation.
  return prisma.wantListItem.upsert({
    where: { userId_cardId_intent: { userId, cardId, intent } },
    update: {},
    create: { userId, cardId, intent },
  });
}

/** Moves an item to a different tab (atomic intent change). */
export async function moveWantListItem(userId: string, id: string, intent: WantIntent) {
  const { intent: validIntent } = MoveWantListSchema.parse({ intent });
  return prisma.wantListItem.update({
    where: { id, userId },
    data: { intent: validIntent },
  });
}

/** Removes an item the user owns. */
export async function removeWantListItem(userId: string, id: string) {
  return prisma.wantListItem.delete({ where: { id, userId } });
}
