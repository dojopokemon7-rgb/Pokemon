/**
 * GET/POST /api/cron/refresh-owned-prices
 *
 * Scheduled by Vercel Cron (see vercel.json, 03:00 UTC daily). Also invocable
 * manually — include the CRON_SECRET as either an Authorization bearer or a
 * `?secret=` query param. Refreshes CURRENT price for the OWNED-cards set only
 * (distinct active holdings across all users), via refreshOwnedPrices(). It
 * does NOT touch history / population / the on-view 7-day cadence.
 *
 * -----------------------------------------------------------------
 * Auth (fail-CLOSED — do NOT regress)
 * -----------------------------------------------------------------
 * Vercel Cron transmits `Authorization: Bearer $CRON_SECRET` when the env var
 * is defined on the project. We accept the same header, plus a `?secret=` query
 * for curl-style manual runs. Both compare with a constant-time check to
 * prevent timing attacks on the secret.
 *
 * If CRON_SECRET is unset, this FAILS CLOSED in production (reject) and only
 * allows the unauthenticated pass-through in non-production (local dev). A
 * missing secret must NEVER let an anonymous caller trigger a credit-spending
 * refresh in prod.
 */
import { NextResponse, type NextRequest } from "next/server";
import { refreshOwnedPrices } from "@/lib/services/owned-price-refresh.service";
import { timingSafeEqual } from "node:crypto";

// This route touches the DB + external HTTP; nothing about it should ever be
// cached, and it must run on the node runtime (Prisma isn't Edge-compatible).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel Hobby ignores this (60s cap); Pro honours it. refreshOwnedPrices
// self-enforces a ~250s wall-clock budget regardless, so it returns cleanly on
// Hobby too.
export const maxDuration = 300;

function authorised(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Fail-CLOSED in production: a missing CRON_SECRET must NOT allow an
    // unauthenticated, credit-spending refresh to be triggered by anyone. Only
    // allow the unconfigured pass-through in non-production (local dev).
    return process.env.NODE_ENV !== "production";
  }
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
    const summary = await refreshOwnedPrices();
    return NextResponse.json({ ok: true, summary }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[cron/refresh-owned-prices] Fatal:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handler(request);
}
export async function POST(request: NextRequest): Promise<NextResponse> {
  return handler(request);
}
