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
});
export type AddWantListInput = z.infer<typeof AddWantListSchema>;

/** Move an item to a different tab (change intent). */
export const MoveWantListSchema = z.object({
  intent: WantIntentEnum,
});
