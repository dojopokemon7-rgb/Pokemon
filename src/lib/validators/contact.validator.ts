/**
 * Zod schema for POST /api/contact (public landing contact form). The client
 * (landing/src/lib/contact.js) mirrors these limits for inline validation; this
 * schema is the authority.
 */
import { z } from "zod";

export const CONTACT_LIMITS = {
  name: 100,
  email: 254,
  subject: 150,
  messageMin: 10,
  messageMax: 5000,
} as const;

// Same shape as the grading-notify email rule; [^\s@] also rules out CR/LF, so a
// validated address is header-safe by construction.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const trimmed = (v: unknown) => str(v).trim();

export const ContactSchema = z.object({
  name: z.preprocess(
    trimmed,
    z
      .string()
      .min(1, "Tell us your name.")
      .max(CONTACT_LIMITS.name, `Keep your name under ${CONTACT_LIMITS.name} characters.`)
  ),
  email: z.preprocess(
    trimmed,
    z
      .string()
      .max(CONTACT_LIMITS.email, "That email doesn’t look right.")
      .regex(EMAIL_RE, "That email doesn’t look right.")
  ),
  subject: z.preprocess(
    trimmed,
    z.string().max(CONTACT_LIMITS.subject, `Keep the subject under ${CONTACT_LIMITS.subject} characters.`)
  ),
  message: z.preprocess(
    trimmed,
    z
      .string()
      .min(CONTACT_LIMITS.messageMin, `Write at least ${CONTACT_LIMITS.messageMin} characters.`)
      .max(CONTACT_LIMITS.messageMax, `Keep the message under ${CONTACT_LIMITS.messageMax} characters.`)
  ),
  // Honeypot: real visitors never see it. Any value is accepted here; the route
  // swallows the submission silently when it is non-empty.
  website: z.preprocess(str, z.string().max(1000)),
  // Which landing page the form was on; anything unexpected falls back.
  page: z.preprocess(
    (v) => (/^\/[a-z0-9/_-]{0,60}$/i.test(str(v)) ? str(v) : "/contact"),
    z.string()
  ),
});

export type ContactInput = z.infer<typeof ContactSchema>;

/** First message per field, for the client's inline errors. */
export function contactFieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}