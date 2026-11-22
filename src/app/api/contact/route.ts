/**
 * POST /api/contact  (PUBLIC, unauthenticated)
 *
 * Backend for the landing's /contact form. The message is EMAILED to
 * CONTACT_TO_EMAIL (default dojo.collect@nodwin.com) via SES with Reply-To set to
 * the visitor; nothing is stored in the database.
 *
 * Order of checks (cheapest first, nothing is parsed until the body is capped):
 *   405 any non-POST method            { error: "Use POST." }
 *   403 cross-origin Origin header     (same check as /api/grading/notify)
 *   415 non-JSON content-type
 *   429 per-IP rate limit (3/min, RATELIMIT_CONTACT_PER_MIN; Redis optional and
 *       fail-open per RULE 1)
 *   413 body > 16 KiB (checked while streaming, BEFORE JSON.parse)
 *   400 bad JSON, or Zod field errors  { error, fields }
 *   200 { ok: true }  honeypot filled -> SAME success response, NO email sent
 *   500 { error }     SES unconfigured or the send threw — never a fake success
 *   200 { ok: true }  sent
 * LOGS: one line on failure with the error name only, never the message body or
 * the visitor's email address.
 */
import { NextResponse } from "next/server";
import { clientIp, contactTier, enforceRateLimit } from "@/lib/utils/rate-limit";
import { readCapped, sameOrigin } from "@/lib/utils/public-form";
import { ContactSchema, contactFieldErrors } from "@/lib/validators/contact.validator";
import { sendContactMessage } from "@/lib/services/contact.service";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });

export async function POST(request: Request): Promise<NextResponse> {
  if (!sameOrigin(request)) return json({ error: "Forbidden." }, 403);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return json({ error: "Expected a JSON body." }, 415);
  }

  const limited = await enforceRateLimit(request, contactTier(), {
    kind: "ip",
    id: clientIp(request),
  });
  if (limited) {
    const retry = limited.headers.get("Retry-After") ?? "60";
    return json({ error: "Too many messages. Please wait a minute and try again." }, 429, {
      "Retry-After": retry,
    });
  }

  const raw = await readCapped(request, MAX_BODY_BYTES);
  if (raw === null) return json({ error: "Request too large." }, 413);

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }
  const obj = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const parsed = ContactSchema.safeParse(obj);
  if (!parsed.success) {
    return json(
      { error: "Please check the highlighted fields.", fields: contactFieldErrors(parsed.error) },
      400
    );
  }

  // Honeypot: bots fill every field. Answer exactly like a real success, send nothing.
  if (parsed.data.website.trim() !== "") return json({ ok: true });

  try {
    await sendContactMessage(parsed.data);
  } catch (err) {
    console.error(`[contact] send failed (${(err as Error | null)?.name ?? "unknown"})`);
    return json(
      { error: "Could not send your message right now. Please email dojo.collect@nodwin.com." },
      500
    );
  }
  return json({ ok: true });
}

const notAllowed = () => json({ error: "Use POST." }, 405, { Allow: "POST" });
export const GET = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
