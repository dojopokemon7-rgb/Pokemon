/**
 * Zod schema for POST /api/grading/notify. Mirrors the landing Cloudflare
 * Worker (dojo-landing/src/worker/index.js) rule-for-rule so the existing
 * frontend works unchanged: same email regex, 254 cap, enums, and the same
 * user-facing error strings (the client shows `error` verbatim).
 */
import { z } from "zod";

export const GRADING_CATEGORIES = ["cards", "comics", "both"] as const;
export const GRADING_VOLUMES = ["1-10", "11-50", "51-200", "200+"] as const;

// Worker's exact regex (unicode apostrophes in the messages are intentional).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const str = (v: unknown) => String(v ?? "");

export const GradingInterestSchema = z.object({
  email: z.preprocess(
    (v) => str(v).trim().toLowerCase(),
    z.string().max(254).regex(EMAIL_RE)
  ),
  category: z.preprocess(str, z.enum(GRADING_CATEGORIES)),
  volume: z.preprocess(str, z.enum(GRADING_VOLUMES)),
  // Bounded, optional; truncated (not rejected) like the Worker. Unknown keys
  // are stripped by z.object.
  source: z.preprocess(
    (v) => (v ? str(v).slice(0, 40) : null),
    z.string().nullable()
  ),
});
export type GradingInterestInput = z.infer<typeof GradingInterestSchema>;

/** First failing field -> the Worker's message (email, then category, then volume). */
export function firstGradingError(error: z.ZodError): string {
  const field = error.issues[0]?.path[0];
  if (field === "category") return "Pick what you’d send.";
  if (field === "volume") return "Pick roughly how many.";
  return "That email doesn’t look right.";
}
