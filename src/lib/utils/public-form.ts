/**
 * Shared guards for PUBLIC (unauthenticated) JSON form endpoints:
 * /api/grading/notify and /api/contact. Pure request helpers, no side effects.
 */

/**
 * Streams the body, aborting as soon as it exceeds `maxBytes`. null = too large.
 * Run it BEFORE JSON.parse so an oversize payload is never buffered or parsed.
 */
export async function readCapped(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
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

/**
 * ORIGIN CHECK: browsers always send Origin on a same-origin fetch POST; if it
 * is present and its host differs from the request host we reject. Absent
 * Origin (curl, tests) is allowed — it is defense-in-depth on top of the
 * JSON-only content-type (cross-site JSON needs a CORS preflight we never grant).
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return !host || new URL(origin).host === host;
  } catch {
    return false;
  }
}