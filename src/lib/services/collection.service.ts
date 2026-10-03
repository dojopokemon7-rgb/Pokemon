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

/** Lists the user's collections, newest first. */
export async function listCollections(userId: string) {
  return prisma.collection.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

/** Creates a new collection for the user. */
export async function createCollection(userId: string, input: CreateCollectionInput) {
  // Applies defaults (isPrivate=true, typeTag=MIXED) and rejects empty names.
  const data = CreateCollectionSchema.parse(input);
  // The virtual ALL view name is reserved — a real collection can't claim it.
  if (data.name.trim().toLowerCase() === ALL_VIEW_NAME.toLowerCase()) {
    throw new VirtualCollectionReadonlyError();
  }
  return prisma.collection.create({
    data: {
      userId,
      name: data.name,
      isPrivate: data.isPrivate,
      typeTag: data.typeTag,
    },
  });
}

/** Renames a collection the user owns (never the virtual ALL view). */
export async function renameCollection(userId: string, collectionId: string, name: string) {
  assertNotVirtual(collectionId);
  const validName = CollectionNameSchema.parse(name);
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
  return prisma.collection.update({
    where: { id: collectionId, userId },
    data,
  });
}
