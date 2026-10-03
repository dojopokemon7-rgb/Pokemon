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
  type MoveWantListInput,
  type WantIntent,
} from "@/lib/validators/want-list.validator";

/** Options for scoping a want-list read (F-#8). */
export interface ListWantListOptions {
  intent?: WantIntent;
  /**
   * Collection scope filter:
   *   - null         → account-level rows (collectionId IS NULL)
   *   - a string id  → that collection
   *   - key OMITTED  → all scopes (back-compat intent-only query)
   */
  collectionId?: string | null;
}

/**
 * Lists a user's want-list items, optionally filtered to one intent tab and/or
 * one collection scope (F-#8).
 *
 * `WantListItem.cardId` holds the EXTERNAL card id (e.g. "base1-4"), not
 * a FK to Card, so we resolve the display fields (name + image) with a
 * single `Card` lookup keyed by `externalId` and merge them in. Cards not
 * in the local catalog fall back to `name: null` / `imageUrl: null`; the
 * UI then shows the raw id, so an unknown card never breaks the list.
 */
export async function listWantList(userId: string, opts: ListWantListOptions = {}) {
  const items = await prisma.wantListItem.findMany({
    where: {
      userId,
      ...(opts.intent ? { intent: opts.intent } : {}),
      // Only constrain collectionId when the caller passes the key. `null`
      // explicitly selects account-level rows (Prisma renders IS NULL);
      // omitting the key returns every scope (FR-4.4 back-compat).
      ...("collectionId" in opts ? { collectionId: opts.collectionId } : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  if (items.length === 0) return [];

  const cards = await prisma.card.findMany({
    where: { externalId: { in: items.map((i) => i.cardId) } },
    select: { externalId: true, name: true, imageUrl: true, marketPrice: true, weeklyChangePct: true, set: { select: { name: true } } },
  });
  const byExternalId = new Map(cards.map((c) => [c.externalId, c]));

  return items.map((item) => {
    const card = byExternalId.get(item.cardId);
    return {
      ...item,
      name: card?.name ?? null,
      imageUrl: card?.imageUrl ?? null,
      marketPrice: card?.marketPrice ?? null,
      // REAL 7-day % change (Scrydex trends.days_7). Null until a priced pull
      // runs — the dashboard want rows render "—", never a fabricated delta.
      weeklyChangePct: card?.weeklyChangePct ?? null,
      setName: card?.set?.name ?? null,
    };
  });
}

/**
 * Adds a card to a want-list tab. Idempotent find-or-create on
 * (userId, cardId, intent, collectionId) at BOTH the null (account) and
 * non-null (collection) scopes (F-#8).
 *
 * NOT an upsert: there is no Prisma @@unique on WantListItem (the real
 * uniqueness is the COALESCE expression index `wli_scope_coalesced`, which
 * Prisma cannot model), so there is no compound key for ON CONFLICT, and an
 * ON CONFLICT against a NULL-distinct plain unique would NOT dedupe the
 * account-level (null) scope. `findFirst` with `collectionId: null` matches
 * by value (IS NULL), so the null scope is idempotent in app code. The
 * expression index remains the DB backstop for a true concurrent race (the
 * route maps that P2002 to the same idempotent success).
 */
export async function addWantListItem(userId: string, input: AddWantListInput) {
  const { cardId, intent, collectionId } = AddWantListSchema.parse(input);
  const scope = collectionId ?? null;
  const existing = await prisma.wantListItem.findFirst({
    where: { userId, cardId, intent, collectionId: scope },
  });
  if (existing) return existing; // idempotent — no second row
  return prisma.wantListItem.create({
    data: { userId, cardId, intent, collectionId: scope },
  });
}

/**
 * Moves an item to a different tab (atomic intent change) and optionally
 * re-scopes it to another collection (F-#8). Ownership-scoped `where:{id,userId}`
 * (foreign id → P2025 → 404). A move that collides on `wli_scope_coalesced`
 * throws P2002 → the route's 409.
 */
export async function moveWantListItem(userId: string, id: string, data: MoveWantListInput) {
  const { intent, collectionId } = MoveWantListSchema.parse(data);
  return prisma.wantListItem.update({
    where: { id, userId },
    data: { intent, ...("collectionId" in data ? { collectionId: collectionId ?? null } : {}) },
  });
}

/** Removes an item the user owns. */
export async function removeWantListItem(userId: string, id: string) {
  return prisma.wantListItem.delete({ where: { id, userId } });
}
