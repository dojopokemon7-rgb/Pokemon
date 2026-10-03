/**
 * /api/want-list
 *   GET  ?intent=BUY|SELL|TRADE → list the user's want-list items (all if omitted)
 *   POST { cardId, intent }     → add a card to a want-list tab
 * Auth required; scoped to the session user.
 */

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/utils/auth-guard";
import { addWantListItem, listWantList } from "@/lib/services/want-list.service";
import { AddWantListSchema, WantIntentEnum } from "@/lib/validators/want-list.validator";
import { prisma } from "@/lib/db";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { RedisKeys, CACHE_TTL } from "@/lib/redis";
import { cacheGetJson, cacheSetJson, invalidateUserCaches } from "@/lib/utils/cache";

export async function GET(request: Request): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;

  const userId = guard.session.user.id;
  const params = new URL(request.url).searchParams;
  const intentParam = params.get("intent");
  const parsedIntent = intentParam ? WantIntentEnum.safeParse(intentParam) : null;
  const intent = parsedIntent?.success ? parsedIntent.data : undefined;

  // F-#8 collection scope. `__account__` → null (account-level rows); a present
  // non-empty id → that collection; ABSENT (null) → omit the key (all scopes).
  const collParam = params.get("collectionId");
  const scopeOpts =
    collParam === null
      ? {}
      : { collectionId: collParam === "__account__" ? null : collParam };

  // Per-user, per-intent, per-scope cache (RULE 5 — key embeds userId; intent →
  // "all" when omitted). F-#8 adds the collection scope to the key suffix so a
  // scoped list can't be served a stale all-scopes payload; the whole family is
  // still invalidated via wantListPattern. A Redis fault returns null → live
  // listWantList below.
  // INVALIDATED BY: want-list add (POST below) / move / remove (whole family).
  const scopeToken = collParam === null ? "all" : collParam;
  const cacheKey = `${RedisKeys.wantList(userId, intent)}:${scopeToken}`;
  const cached = await cacheGetJson<{ data: unknown[] }>(cacheKey);
  if (cached) {
    return NextResponse.json(cached, { headers: { "Cache-Control": "no-store" } });
  }

  // Defensive: a DB hiccup should degrade to an empty list, not a 500 that
  // breaks the want-list tabs / dashboard / search star.
  try {
    const items = await listWantList(userId, { intent, ...scopeOpts });
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

  const userId = guard.session.user.id;
  try {
    // F-#8: validate up-front so we can run the cross-user ownership guard on a
    // non-null collectionId BEFORE any write (the FK only checks existence, so a
    // user could otherwise file a want row under a collection they don't own).
    const parsed = AddWantListSchema.parse(body);
    if (parsed.collectionId != null) {
      const owned = await prisma.collection.findFirst({
        where: { id: parsed.collectionId, userId },
      });
      if (!owned) {
        return NextResponse.json(
          { error: "Not Found", message: "Collection not found." },
          { status: 404 }
        );
      }
    }
    const item = await addWantListItem(userId, parsed);
    // Invalidate the want-list family + dashboard (dashboard counts want
    // totals): wantlist:{userId}:* + dashboard:{userId}. Best-effort.
    await invalidateUserCaches(userId, ["wantlist", "dashboard"]);
    return NextResponse.json({ data: item }, { status: 201 });
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json(
        { error: "Validation Error", message: err.issues[0]?.message ?? "Invalid input." },
        { status: 400 }
      );
    }
    // A concurrent race on `wli_scope_coalesced` (two adds slipped past the
    // service findFirst) is NOT a user-facing conflict: the row the user wanted
    // now exists. Re-read it and return the same idempotent 201.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const parsed = AddWantListSchema.parse(body);
      const raced = await prisma.wantListItem.findFirst({
        where: {
          userId,
          cardId: parsed.cardId,
          intent: parsed.intent,
          collectionId: parsed.collectionId ?? null,
        },
      });
      if (raced) return NextResponse.json({ data: raced }, { status: 201 });
    }
    throw err;
  }
}
