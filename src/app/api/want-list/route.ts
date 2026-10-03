/**
 * /api/want-list
 *   GET  ?intent=BUY|SELL|TRADE → list the user's want-list items (all if omitted)
 *   POST { cardId, intent }     → add a card to a want-list tab
 * Auth required; scoped to the session user.
 */

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/utils/auth-guard";
import { addWantListItem, listWantList } from "@/lib/services/want-list.service";
import { WantIntentEnum } from "@/lib/validators/want-list.validator";
import { ZodError } from "zod";
import { RedisKeys, CACHE_TTL } from "@/lib/redis";
import { cacheGetJson, cacheSetJson, invalidateUserCaches } from "@/lib/utils/cache";

export async function GET(request: Request): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;

  const userId = guard.session.user.id;
  const intentParam = new URL(request.url).searchParams.get("intent");
  const parsedIntent = intentParam ? WantIntentEnum.safeParse(intentParam) : null;
  const intent = parsedIntent?.success ? parsedIntent.data : undefined;

  // Per-user, per-intent cache (RULE 5 — key embeds userId; intent → "all"
  // when omitted). A Redis fault returns null → live listWantList below.
  // INVALIDATED BY: want-list add (POST below) / move / remove (whole family).
  const cacheKey = RedisKeys.wantList(userId, intent);
  const cached = await cacheGetJson<{ data: unknown[] }>(cacheKey);
  if (cached) {
    return NextResponse.json(cached, { headers: { "Cache-Control": "no-store" } });
  }

  // Defensive: a DB hiccup should degrade to an empty list, not a 500 that
  // breaks the want-list tabs / dashboard / search star.
  try {
    const items = await listWantList(userId, intent);
    await cacheSetJson(cacheKey, { data: items }, CACHE_TTL.wantList);
    return NextResponse.json({ data: items }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[want-list] GET failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ data: [] }, { headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad Request", message: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const item = await addWantListItem(guard.session.user.id, body as never);
    // Invalidate the want-list family + dashboard (dashboard counts want
    // totals): wantlist:{userId}:* + dashboard:{userId}. Best-effort.
    await invalidateUserCaches(guard.session.user.id, ["wantlist", "dashboard"]);
    return NextResponse.json({ data: item }, { status: 201 });
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        { error: "Validation Error", message: err.issues[0]?.message ?? "Invalid input." },
        { status: 400 }
      );
    }
    throw err;
  }
}
