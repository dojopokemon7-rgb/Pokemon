/**
 * Collection Service — F-10 Multiple Collections.
 *
 * CRUD + privacy/tag settings for user-owned named collections, backed by
 * the Prisma `Collection` model (Supabase/Postgres).
 *
 * OWNERSHIP: every mutation scopes its `where` to the acting `userId`, so a
 * user can only touch their own collections. If the id doesn't belong to the
 * user, Prisma finds no row and throws (P2025 "record not found") — the same
 * as if it didn't exist, which avoids leaking other users' collection ids.
 *
 * VALIDATION: inputs pass through the Zod schemas in collection.validator so
 * empty names / invalid tags are rejected before any DB call.
 */

import { prisma } from "@/lib/db";
import {
  CreateCollectionSchema,
  CollectionNameSchema,
  UpdateCollectionSettingsSchema,
  type CreateCollectionInput,
  type UpdateCollectionSettingsInput,
} from "@/lib/validators/collection.validator";
import { isVirtualCollectionId, ALL_VIEW_NAME } from "@/lib/utils/collections-virtual";
import { countSoldRowsByCollection } from "@/lib/utils/sold-bucket";
import { isMainCollectionName, MAIN_COLLECTION_NAME } from "@/lib/utils/main-collection";
import { invalidateUserCaches } from "@/lib/utils/cache";
import { Prisma } from "@prisma/client";

/** Thrown when a write targets the built-in, non-editable virtual ALL view. */
export class VirtualCollectionReadonlyError extends Error {
  constructor() {
    super("The All Cards view is built-in and cannot be renamed, deleted, or edited.");
    this.name = "VirtualCollectionReadonlyError";
  }
}

/** Reject any mutation aimed at the reserved virtual ALL view id. */
function assertNotVirtual(collectionId: string): void {
  if (isVirtualCollectionId(collectionId)) throw new VirtualCollectionReadonlyError();
}

/** Thrown when a write targets (or would duplicate) the protected Main collection. */
export class MainCollectionProtectedError extends Error {
  constructor(message = "Main is the default collection and cannot be renamed, deleted, or edited.") {
    super(message);
    this.name = "MainCollectionProtectedError";
  }
}

/**
 * Reject a mutation when the OWNED collection is Main. Scoped `{ id, userId }`:
 * a foreign/nonexistent id finds no row and falls through to the caller's own
 * P2025 path (same 404, no id leak).
 */
async function assertNotMain(userId: string, collectionId: string): Promise<void> {
  const row = await prisma.collection.findFirst({
    where: { id: collectionId, userId },
    select: { name: true },
  });
  if (row && isMainCollectionName(row.name)) throw new MainCollectionProtectedError();
}

/**
 * Returns the user's Main collection, creating it on first use. Idempotent:
 * the lookup is case/space-insensitive (the DB unique is case-sensitive), and a
 * concurrent create that loses the race (P2002) re-reads the winner's row.
 */
export async function getOrCreateMainCollection(userId: string) {
  const find = async () =>
    (await prisma.collection.findMany({ where: { userId } })).find((c) => isMainCollectionName(c.name));
  const existing = await find();
  if (existing) return existing;
  try {
    const created = await prisma.collection.create({
      data: { userId, name: MAIN_COLLECTION_NAME, isPrivate: true, typeTag: "MIXED" },
    });
    // Collection list / dashboard selector now include Main.
    await invalidateUserCaches(userId, ["collections", "dashboard"]);
    return created;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const raced = await find();
      if (raced) return raced;
    }
    throw e;
  }
}

/** Lists the user's collections, newest first. */
export async function listCollections(userId: string) {
  return prisma.collection.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

/** The five derived per-collection bucket counts (F-#8). */
export interface CollectionBuckets {
  main: number;
  all: number;
  buy: number;
  sell: number;
  sold: number;
}

/** Loose/uncategorized pseudo-collection id (collectionId == null lots). */
export const UNCATEGORIZED_ID = "__uncat__";

/**
 * Runs a groupBy and folds it into a Map; on ANY failure returns an empty Map
 * so the caller zeroes buckets rather than 500ing (rule 7/8).
 */
async function safeGroupBy<T>(fn: () => Promise<T[]>, key: (row: T) => string, value: (row: T) => number) {
  try {
    const rows = await fn();
    const map = new Map<string, number>();
    for (const r of rows) map.set(key(r), value(r));
    return map;
  } catch (err) {
    console.warn("[collections] bucket groupBy failed:", err instanceof Error ? err.message : err);
    return new Map<string, number>();
  }
}

/**
 * Lists the user's collections WITH their five derived buckets (F-#8, design §6a).
 *
 * UNITS (the buckets carry DIFFERENT units):
 *   main / all  = summed QUANTITIES (_sum.quantity)
 *   buy  / sell = ROW COUNTS        (_count._all)
 *   sold        = CONSOLIDATED ROW COUNT — one per distinct card+foil+condition
 *                 +soldPrice lot, matching the Sold VIEW's item count (QA #4).
 *                 Previously this summed quantity, so "Sold 2" disagreed with the
 *                 view's "1 item"; countSoldRowsByCollection collapses to parity.
 *
 * Three grouped reads (no N+1). A groupBy hiccup degrades to an empty Map, so
 * every collection's buckets are ASSEMBLED with `?? 0` → always ZEROED, never
 * undefined. The base findMany is NOT wrapped here — the route owns that fallback.
 * A `__uncat__` pseudo-collection carries the loose (collectionId=null) counts.
 */
export async function listCollectionsWithBuckets(userId: string) {
  const collections = await prisma.collection.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  const activeMap = await safeGroupBy(
    () =>
      prisma.userCollection.groupBy({
        by: ["collectionId"],
        where: { userId, isSold: false },
        _sum: { quantity: true },
      }),
    (r) => `${r.collectionId ?? UNCATEGORIZED_ID}`,
    (r) => r._sum.quantity ?? 0
  );
  // Sold = count of CONSOLIDATED sold rows (parity with the Sold view, QA #4), so
  // we pull the sold lots' identity fields and collapse them in a pure util rather
  // than summing quantity. Same graceful degradation: a read fault → empty Map → 0.
  let soldMap = new Map<string, number>();
  try {
    const soldLots = await prisma.userCollection.findMany({
      where: { userId, isSold: true },
      select: { collectionId: true, cardId: true, isFoil: true, condition: true, soldPrice: true },
    });
    soldMap = countSoldRowsByCollection(soldLots);
  } catch (err) {
    console.warn("[collections] sold-bucket read failed:", err instanceof Error ? err.message : err);
  }
  const wantMap = await safeGroupBy(
    () =>
      prisma.wantListItem.groupBy({
        by: ["collectionId", "intent"],
        where: { userId },
        _count: { _all: true },
      }),
    (r) => `${r.collectionId ?? UNCATEGORIZED_ID}|${r.intent}`,
    (r) => r._count._all ?? 0
  );

  const bucketsFor = (id: string): CollectionBuckets => {
    const active = activeMap.get(id) ?? 0; // Σ quantity
    return {
      main: active,
      all: active,
      sold: soldMap.get(id) ?? 0, // consolidated row count (parity with Sold view)
      buy: wantMap.get(`${id}|BUY`) ?? 0, // row count
      sell: wantMap.get(`${id}|SELL`) ?? 0, // row count
    };
  };

  const named = collections.map((c) => ({ ...c, buckets: bucketsFor(c.id) }));
  // The loose set is always present as a pseudo-collection so the UI can render
  // its chip bar even when the user has no named collections.
  const uncat = { id: UNCATEGORIZED_ID, buckets: bucketsFor(UNCATEGORIZED_ID) };
  return [...named, uncat] as Array<
    (typeof named)[number] | { id: string; buckets: CollectionBuckets }
  >;
}

/** Creates a new collection for the user. */
export async function createCollection(userId: string, input: CreateCollectionInput) {
  // Applies defaults (isPrivate=true, typeTag=MIXED) and rejects empty names.
  const data = CreateCollectionSchema.parse(input);
  // The virtual ALL view name is reserved — a real collection can't claim it.
  if (data.name.trim().toLowerCase() === ALL_VIEW_NAME.toLowerCase()) {
    throw new VirtualCollectionReadonlyError();
  }
  // "main" in any case is reserved for the protected Main collection: a second
  // one is a conflict; if Main doesn't exist yet, create it under the canonical name.
  const claimsMain = isMainCollectionName(data.name);
  if (claimsMain) {
    const rows = await prisma.collection.findMany({ where: { userId } });
    if (rows.some((c) => isMainCollectionName(c.name))) {
      throw new MainCollectionProtectedError("You already have a Main collection.");
    }
  }
  return prisma.collection.create({
    data: {
      userId,
      name: claimsMain ? MAIN_COLLECTION_NAME : data.name,
      isPrivate: data.isPrivate,
      typeTag: data.typeTag,
    },
  });
}

/** Renames a collection the user owns (never the virtual ALL view). */
export async function renameCollection(userId: string, collectionId: string, name: string) {
  assertNotVirtual(collectionId);
  const validName = CollectionNameSchema.parse(name);
  await assertNotMain(userId, collectionId);
  // Nobody may rename another collection INTO "Main" either.
  if (isMainCollectionName(validName)) throw new MainCollectionProtectedError("“Main” is reserved.");
  // Guard against renaming a real collection INTO the reserved view name.
  if (validName.trim().toLowerCase() === ALL_VIEW_NAME.toLowerCase()) {
    throw new VirtualCollectionReadonlyError();
  }
  return prisma.collection.update({
    where: { id: collectionId, userId },
    data: { name: validName },
  });
}

/**
 * Deletes a collection the user owns (never the virtual ALL view).
 *
 * SAFE & ATOMIC re-home (audit 05 F-01 / 01 P-05). The FK
 * `UserCollection.collectionId` is `onDelete: SetNull`, so a bare delete would
 * NULL this collection's active lots' `collectionId`. The partial unique index
 * `uc_variant_coalesced` — UNIQUE(userId, COALESCE(collectionId,''), cardId,
 * isFoil, COALESCE(condition,'')) WHERE isSold=false — treats NULL as ''. If the
 * user already holds a NULL-scoped (uncategorized) active lot of the same
 * (cardId, isFoil, condition), SetNull would collide → Postgres P2002 → an
 * uncaught 500 and the collection silently survives.
 *
 * Instead, BEFORE deleting, we re-home the collection's ACTIVE lots to the
 * NULL/uncategorized scope by MERGING into any colliding NULL-scoped active lot
 * (bump its quantity, drop the duplicate — quantity conserved, RULE 2), else
 * just NULL the lot. `WantListItem.collectionId` is also SetNull under
 * `wli_scope_coalesced` UNIQUE(userId, COALESCE(collectionId,''), cardId,
 * intent): a deleted collection's want rows fall to account level and can
 * collide with an existing account-scoped want row of the same (cardId, intent)
 * — a want row has no quantity, so a collision is resolved by deleting the
 * duplicate, else NULL the row. The lot merge, the want-row remediation, and the
 * collection delete all run in ONE `$transaction` so any failure rolls back
 * cleanly. Sold lots are untouched: the index is partial on isSold=false, so
 * sold rows SetNull harmlessly.
 *
 * This mirrors the sell-revert merge-back (commit 8bafcf8). The caller maps a
 * concurrent P2002 (a sibling created between our read and the delete commit) to
 * 409, so a legitimate delete is never blocked by a bare 500.
 */
export async function deleteCollection(userId: string, collectionId: string) {
  assertNotVirtual(collectionId);
  await assertNotMain(userId, collectionId);

  // Same normalization the add route / sell-revert fix use so the app-side
  // variant key matches the DB index's COALESCE(condition,'').
  const norm = (c: string | null | undefined) => (c ?? "").trim().toUpperCase();

  return prisma.$transaction(async (tx) => {
    // --- Re-home active lots, merging on NULL-scope collision ----------------
    const lots = await tx.userCollection.findMany({
      where: { collectionId, userId, isSold: false },
    });
    // Index the user's existing NULL-scoped active lots by variant key so a
    // collision folds into the sibling. Mutated in-place as lots are re-homed so
    // two source lots that share a key both fold into the same target.
    const nullScoped = await tx.userCollection.findMany({
      where: { userId, collectionId: null, isSold: false },
    });
    const lotKey = (l: { cardId: string; isFoil: boolean; condition: string | null }) =>
      `${l.cardId}|${l.isFoil}|${norm(l.condition)}`;
    const siblingByKey = new Map<string, { id: string; quantity: number }>();
    for (const s of nullScoped) siblingByKey.set(lotKey(s), { id: s.id, quantity: s.quantity });

    for (const lot of lots) {
      const key = lotKey(lot);
      const sibling = siblingByKey.get(key);
      if (sibling) {
        // Collision: merge into the NULL-scoped sibling, drop the duplicate.
        const mergedQty = sibling.quantity + lot.quantity;
        await tx.userCollection.update({
          where: { id: sibling.id },
          data: { quantity: mergedQty },
        });
        await tx.userCollection.delete({ where: { id: lot.id } });
        sibling.quantity = mergedQty; // a later same-key lot folds into this one
      } else {
        // No collision: re-home to NULL scope and register it as a sibling so a
        // later same-key lot in this batch merges into it.
        await tx.userCollection.update({
          where: { id: lot.id },
          data: { collectionId: null },
        });
        siblingByKey.set(key, { id: lot.id, quantity: lot.quantity });
      }
    }

    // --- Re-home want rows, deleting on NULL-scope collision -----------------
    const wants = await tx.wantListItem.findMany({ where: { collectionId, userId } });
    const nullWants = await tx.wantListItem.findMany({
      where: { userId, collectionId: null },
    });
    const wantKey = (w: { cardId: string; intent: string }) => `${w.cardId}|${w.intent}`;
    const wantSeen = new Set<string>(nullWants.map(wantKey));
    for (const want of wants) {
      const key = wantKey(want);
      if (wantSeen.has(key)) {
        // Collision: a null-scoped want of this (cardId, intent) already exists.
        // Want rows have no quantity, so just drop the duplicate.
        await tx.wantListItem.delete({ where: { id: want.id } });
      } else {
        await tx.wantListItem.update({ where: { id: want.id }, data: { collectionId: null } });
        wantSeen.add(key);
      }
    }

    // --- Delete the collection (ownership-scoped) ----------------------------
    return tx.collection.delete({ where: { id: collectionId, userId } });
  });
}

/** Updates privacy and/or type tag on a collection the user owns (never ALL). */
export async function updateCollectionSettings(
  userId: string,
  collectionId: string,
  input: UpdateCollectionSettingsInput
) {
  assertNotVirtual(collectionId);
  // Rejects invalid tags before touching the DB.
  const data = UpdateCollectionSettingsSchema.parse(input);
  await assertNotMain(userId, collectionId);
  return prisma.collection.update({
    where: { id: collectionId, userId },
    data,
  });
}
