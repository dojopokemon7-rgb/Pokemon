/**
 * Want List validation (F-07). Mirrors the Prisma `WantIntent` enum.
 */

import { z } from "zod";

export const WantIntentEnum = z.enum(["BUY", "SELL", "TRADE"]);
export type WantIntent = z.infer<typeof WantIntentEnum>;

/** Add a card to a want-list tab. */
export const AddWantListSchema = z.object({
  cardId: z.string().trim().min(1, "cardId is required."),
  intent: WantIntentEnum,
  // F-#8: optionally scope to a named collection. null/absent = account-level
  // (legacy scope). No max — matches the sibling AddCardSchema.collectionId;
  // collection ids are ~25-char cuids and the FK rejects any non-existent id.
  collectionId: z.string().trim().min(1).nullish(),
});
export type AddWantListInput = z.infer<typeof AddWantListSchema>;

/** Move an item to a different tab (change intent) and optionally re-scope it. */
export const MoveWantListSchema = z.object({
  intent: WantIntentEnum,
  // F-#8: supplying collectionId moves the item between collection scopes;
  // omitting it changes only the intent (back-compat).
  collectionId: z.string().trim().min(1).nullish(),
});
export type MoveWantListInput = z.infer<typeof MoveWantListSchema>;
