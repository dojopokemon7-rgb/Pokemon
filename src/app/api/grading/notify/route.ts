/**
 * POST /api/grading/notify  (PUBLIC, unauthenticated)
 *
 * Backend for the landing's CGC grading "notify me" form. Request contract and
 * response shapes match the landing Cloudflare Worker exactly so the prebuilt
 * frontend (src/lib/gradingNotify.js) works unchanged:
 *   200 { ok: true, returning: false }   saved (see NO-ENUMERATION below)
 *   400 { error }                        bad JSON / email / category / volume
 *   405 { error: "Use POST." }           any other method
 *   500 { error: "Could not save that right now." }
 * Added hardening (same `{ error }` shape, which the client displays):
 *   413 body > 4 KiB (checked while streaming, BEFORE parsing)
 *   415 non-JSON content-type
 *   403 cross-origin Origin header
 *   429 per-IP rate limit (5/min, BEFORE the DB write; Redis optional/fail-open
 *       per RULE 1 — a cache outage disables the limit, never blocks)
 *
 * NO ENUMERATION: new and existing addresses get the IDENTICAL response
 * (status + body). The Worker returned 201/200 + `returning`; the form's
 * "already on the list" copy is therefore never shown — deliberate trade-off.
 * ORIGIN CHECK: browsers always send Origin on a same-origin fetch POST; if it
 * is present and its host differs from the request host we reject. Absent
 * Origin (curl, tests) is allowed — it is defense-in-depth on top of the
 * JSON-only content-type (cross-site JSON needs a CORS preflight we never grant).
 * LOGS: never contain the email (PII) — only the Prisma error code.
 */
import { NextResponse } from "next/server";
import { clientIp, enforceRateLimit, gradingNotifyTier } from "@/lib/utils/rate-limit";
import {
  GradingInterestSchema,
  firstGradingError,
} from "@/lib/validators/grading-interest.validator";
import { isMissingTable, upsertGradingInterest } from "@/lib/services/grading-interest.service";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });

/** Streams the body, aborting as soon as it exceeds the cap. null = too large. */
async function readCapped(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return ""; // transport error -> fails JSON parse -> 400
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return !host || new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!sameOrigin(request)) return json({ error: "Forbidden." }, 403);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return json({ error: "Expected a JSON body." }, 415);
  }

  const limited = await enforceRateLimit(request, gradingNotifyTier(), {
    kind: "ip",
    id: clientIp(request),
  });
  if (limited) {
    const retry = limited.headers.get("Retry-After") ?? "60";
    return json({ error: "Too many tries. Please wait a minute and try again." }, 429, {
      "Retry-After": retry,
    });
  }

  const raw = await readCapped(request);
  if (raw === null) return json({ error: "Request too large." }, 413);

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }
  const obj = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const parsed = GradingInterestSchema.safeParse(obj);
  if (!parsed.success) return json({ error: firstGradingError(parsed.error) }, 400);

  try {
    await upsertGradingInterest(parsed.data);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? "unknown";
    if (isMissingTable(err)) {
      console.error(
        "[grading-notify] LOUD: table grading_interest is MISSING — apply prisma/migrations/*_add_grading_interest/migration.sql (see docs/ARCHITECTURE.md runbook)"
      );
    } else {
      console.error(`[grading-notify] save failed (code=${code})`);
    }
    return json({ error: "Could not save that right now." }, 500);
  }
  return json({ ok: true, returning: false });
}

const notAllowed = () => json({ error: "Use POST." }, 405, { Allow: "POST" });
export const GET = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
