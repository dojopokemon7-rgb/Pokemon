/**
 * GET/POST /api/cron/sync-cards
 *
 * Scheduled by Vercel Cron (see vercel.json). Also invocable manually for
 * a fresh sync — just include the CRON_SECRET as either an Authorization
 * bearer or a `?secret=` query param.
 *
 * -----------------------------------------------------------------
 * Auth
 * -----------------------------------------------------------------
 * Vercel Cron transmits `Authorization: Bearer $CRON_SECRET` when the
 * env var is defined on the project. We accept the same header, plus
 * a `?secret=` query for `curl`-style manual runs. Both compare with
 * a constant-time check to prevent timing attacks on the secret.
 *
 * If CRON_SECRET is unset (typical local dev), the route accepts
 * unauthenticated requests. Set the env var in production!
 */

import { NextResponse, type NextRequest } from "next/server";
import { runCardSync } from "@/lib/services/sync-cards.service";
import { timingSafeEqual } from "node:crypto";

// This route touches the DB + external HTTP; nothing about it should
// ever be cached, and it must run on the node runtime (Prisma isn't
// Edge-compatible).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Give the sync a big enough budget. Vercel Hobby ignores this (60s
// cap); Pro honours it. `runCardSync` self-enforces a 55s wall-clock
// budget regardless, so we return cleanly on Hobby too.
export const maxDuration = 300;

function authorised(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true; // local dev / unconfigured — allow

  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : "";
  const queryParam = request.nextUrl.searchParams.get("secret") ?? "";
  const supplied = bearer || queryParam;
  if (!supplied) return false;

  // Constant-time compare, guarding against different lengths.
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function handler(request: NextRequest): Promise<NextResponse> {
  if (!authorised(request)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
    );
  }

  try {
    const summary = await runCardSync();
    // A run that touched zero sets is still "successful" from the
    // scheduler's POV — it just had nothing to do today.
    return NextResponse.json({ ok: true, summary }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[cron/sync-cards] Fatal:", message);
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handler(request);
}
export async function POST(request: NextRequest): Promise<NextResponse> {
  return handler(request);
}
