/**
 * Collection Validation Schemas (Zod) — F-10 Multiple Collections.
 *
 * Mirrors the Prisma `CollectionType` enum and guards the mutable fields
 * (name, privacy, tag) at the service boundary so no invalid shape reaches
 * the DB. The API/route layer reuses these same schemas.
 */

import { z } from "zod";

/** The three valid collection type tags. Mirrors Prisma's CollectionType. */
export const CollectionTypeEnum = z.enum(["POKEMON", "ONE_PIECE", "MIXED"]);
export type CollectionType = z.infer<typeof CollectionTypeEnum>;

/** A collection name: required, trimmed, non-empty, bounded. */
export const CollectionNameSchema = z
  .string()
  .trim()
  .min(1, "Collection name is required.")
  .max(100, "Collection name is too long (max 100 characters).");

/** Input for creating a collection. Privacy defaults to private; tag to MIXED. */
export const CreateCollectionSchema = z.object({
  name: CollectionNameSchema,
  isPrivate: z.boolean().default(true),
  typeTag: CollectionTypeEnum.default("MIXED"),
});
export type CreateCollectionInput = z.input<typeof CreateCollectionSchema>;

/** Input for updating privacy / tag. Both optional; at least one is expected. */
export const UpdateCollectionSettingsSchema = z.object({
  isPrivate: z.boolean().optional(),
  typeTag: CollectionTypeEnum.optional(),
});
export type UpdateCollectionSettingsInput = z.infer<typeof UpdateCollectionSettingsSchema>;
