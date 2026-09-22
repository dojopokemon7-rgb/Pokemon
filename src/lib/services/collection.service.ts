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
  return prisma.collection.create({
    data: {
      userId,
      name: data.name,
      isPrivate: data.isPrivate,
      typeTag: data.typeTag,
    },
  });
}

/** Renames a collection the user owns. */
export async function renameCollection(userId: string, collectionId: string, name: string) {
  const validName = CollectionNameSchema.parse(name);
  return prisma.collection.update({
    where: { id: collectionId, userId },
    data: { name: validName },
  });
}

/** Deletes a collection the user owns. */
export async function deleteCollection(userId: string, collectionId: string) {
  return prisma.collection.delete({
    where: { id: collectionId, userId },
  });
}

/** Updates privacy and/or type tag on a collection the user owns. */
export async function updateCollectionSettings(
  userId: string,
  collectionId: string,
  input: UpdateCollectionSettingsInput
) {
  // Rejects invalid tags before touching the DB.
  const data = UpdateCollectionSettingsSchema.parse(input);
  return prisma.collection.update({
    where: { id: collectionId, userId },
    data,
  });
}
