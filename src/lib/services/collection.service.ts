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
 * UNITS (the two halves of `buckets` carry DIFFERENT units):
 *   main / all / sold = summed QUANTITIES (_sum.quantity)
 *   buy  / sell       = ROW COUNTS        (_count._all)
 *
 * Two grouped queries (no N+1). A groupBy hiccup degrades to an empty Map, so
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
        by: ["collectionId", "isSold"],
        where: { userId },
        _sum: { quantity: true },
      }),
    (r) => `${r.collectionId ?? UNCATEGORIZED_ID}|${r.isSold}`,
    (r) => r._sum.quantity ?? 0
  );
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
    const active = activeMap.get(`${id}|false`) ?? 0; // Σ quantity
    return {
      main: active,
      all: active,
      sold: activeMap.get(`${id}|true`) ?? 0, // Σ quantity
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

/** Deletes a collection the user owns (never the virtual ALL view). */
export async function deleteCollection(userId: string, collectionId: string) {
  assertNotVirtual(collectionId);
  await assertNotMain(userId, collectionId);
  return prisma.collection.delete({
    where: { id: collectionId, userId },
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
