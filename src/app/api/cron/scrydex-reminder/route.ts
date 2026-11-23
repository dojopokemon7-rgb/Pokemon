/**
 * GET /api/cron/scrydex-reminder[?dryRun=1]
 *
 * Daily Scrydex renewal + low-credit reminder check (see
 * scrydex-reminder.service.ts). Auth is IDENTICAL to refresh-owned-prices:
 * CRON_SECRET via `Authorization: Bearer` or `?secret=`, constant-time compare,
 * fail-CLOSED in production when the secret is unset. `?dryRun=1` (still
 * guarded) computes everything and reports what WOULD be sent without claiming
 * or sending. Triggered by a host crontab on the Droplet (vercel.json has no
 * crons) — see docs/SCRYDEX_REMINDERS.md.
 */
import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { runScrydexReminder } from "@/lib/services/scrydex-reminder.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorised(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Fail-CLOSED in production (same contract as refresh-owned-prices).
    return process.env.NODE_ENV !== "production";
  }
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const supplied = bearer || (request.nextUrl.searchParams.get("secret") ?? "");
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!authorised(request)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
    );
  }
  const dryRun = ["1", "true"].includes(request.nextUrl.searchParams.get("dryRun") ?? "");
  try {
    return NextResponse.json(await runScrydexReminder({ dryRun }), { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[cron/scrydex-reminder] Fatal:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}