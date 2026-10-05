/**
 * GET  /api/users/me/collection — fetch the authenticated user's collection.
 * POST /api/users/me/collection — add one or more cards to it.
 *
 * Uses requireAuth guard to enforce authentication on both.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAuth } from "@/lib/utils/auth-guard";
import { prisma } from "@/lib/db";
import { assignBulkAddOrder } from "@/lib/utils/bulk-add-order";
import { RedisKeys, CACHE_TTL } from "@/lib/redis";
import { cacheGetJson, cacheSetJson, invalidateUserCaches } from "@/lib/utils/cache";
import { getOrCreateMainCollection } from "@/lib/services/collection.service";

export async function GET(request: Request): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;

  const { session } = guard;
  const userId = session.user.id;

  // Per-user cache (RULE 5 — key embeds userId). A Redis fault returns null →
  // falls through to the live findMany below (NOT a 500). INVALIDATED BY:
  // add (POST below) / sell / update / delete collection item.
  const cacheKey = RedisKeys.userCollection(userId);
  const cached = await cacheGetJson<{ items: unknown[] }>(cacheKey);
  if (cached) return NextResponse.json(cached, { status: 200 });

  try {
    // Explicit `select`: `include: { set: true }` was pulling every
    // CardSet column (symbol/logo URLs, release date, printed totals,
    // audit timestamps) on every row when the dashboard only reads
    // set.name. On a 200-card collection that's kilobytes of dead
    // payload per response.
    const items = await prisma.userCollection.findMany({
      where: { userId },
      orderBy: { addedAt: "desc" },
      select: {
        id: true,
        cardId: true,
        quantity: true,
        condition: true,
        notes: true,
        isFoil: true,
        purchasePrice: true,
        // Cost-basis provenance (plan §5): lets the UI show "unresolved" P&L
        // honestly instead of a fabricated 0 when purchasePrice is null.
        costBasisSource: true,
        costBasisCurrency: true,
        costBasisAttemptedAt: true,
        // F-22: which named collection this copy is filed under (null =
        // uncategorized) — drives the Compare Collections stats.
        collectionId: true,
        isSold: true,
        soldPrice: true,
        soldCurrency: true,
        soldAt: true,
        addedAt: true,
        updatedAt: true,
        card: {
          select: {
            id: true,
            externalId: true,
            name: true,
            number: true,
            rarity: true,
            imageUrl: true,
            imageUrlHi: true,
            marketPrice: true,
            // REAL 7-day % change (Scrydex trends.days_7). Null until a priced
            // pull runs — the dashboard renders "—", never a fabricated delta.
            weeklyChangePct: true,
            // REAL 7-day $ change (same source); drives the portfolio 7-day sort.
            weeklyChangeAbs: true,
            set: { select: { id: true, name: true } },
          },
        },
      },
    });

    // Best-effort cache fill on a miss (helper swallows Redis errors).
    await cacheSetJson(cacheKey, { items }, CACHE_TTL.userCollection);

    return NextResponse.json({ items }, { status: 200 });
  } catch (error) {
    console.error("[api/users/me/collection] Error fetching collection:", error);
    return NextResponse.json(
      {
        error: "Internal Server Error",
        message: "Failed to fetch user collection",
      },
      { status: 500 }
    );
  }
}

// =============================================================
// POST — Add cards to the authenticated user's collection
// =============================================================
//
// Cards come from /api/cards/search or /api/cards/trending, so their
// identity (externalId/name/set/image/price) is already known client-
// side — the client re-sends that payload here rather than the server
// re-fetching it. This route is the *only* place that turns a search
// result into a persisted `Card` + `UserCollection` row; every "add
// this card" action in the app (search grid, multi-select, trending)
// funnels through this one endpoint.
//
// A card is looked up by `externalId` first: if it already exists
// (e.g. seeded via prisma/seed.ts, or added by another user before),
// we reuse that row and just refresh name/image/price. If not, we
// create it — this is how the local catalog organically grows as
// users add cards search never seeded.

const AddCardSchema = z.object({
  externalId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  setName: z.string().trim().optional(),
  imageUrl: z.string().url().optional().or(z.literal("")), // Allow empty string
  rarity: z.string().optional(),
  types: z.array(z.string()).optional(),
  // SECURITY: `marketPrice` is intentionally NOT accepted here. A client-
  // supplied catalog price must never reach a shared Card / pricing_history row
  // (price fabrication / shared-catalog override — RULE 2). The real price
  // comes only from a server-side Scrydex pull. The Add sheet still sends a
  // `marketPrice` field; Zod strips it (object is non-strict), so this is a
  // no-op for the client build — it only means we never WRITE it anywhere.
  quantity: z.number().int().min(1).max(999).default(1),
  isFoil: z.boolean().default(false),
  condition: z.string().trim().optional(),
  // Price the user actually paid — defaults to the card's current
  // market price if omitted (a reasonable default, not a fabricated one).
  purchasePrice: z.number().nullable().optional(),
  // F-10: file this copy under a named collection (omitted = the request's
  // top-level collectionId, else the user's Main). A per-item id that is not
  // owned is coerced to Main (no id leak). The Add sheet's dropdown sets it.
  collectionId: z.string().trim().optional(),
});

const AddCollectionRequestSchema = z.object({
  cards: z.array(AddCardSchema).min(1).max(50),
  // FEAT-004: destination for every item without its own collectionId. Unlike a
  // per-item id, a top-level id that is not owned is a hard 404 with ZERO writes.
  collectionId: z.string().trim().optional(),
  // "increment" (default, back-compat) bumps an existing lot; "skip" leaves it
  // untouched and reports it in `alreadyPresent` (multi-select Add).
  onExisting: z.enum(["increment", "skip"]).default("increment"),
});

/** Derives an in-set card number the same way prisma/seed.ts does. */
function deriveCardNumber(externalId: string): string {
  const parts = externalId.split("-");
  return parts.length > 1 ? parts[parts.length - 1] : externalId;
}

/** Lowercases, strips non-alphanumerics, hyphenates — for a stable set key. */
function slugifySetName(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown-set";
}

export async function POST(request: Request): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;

  const { session } = guard;
  const userId = session.user.id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Bad Request", message: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  const parsed = AddCollectionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Bad Request",
        message: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
      { status: 400 }
    );
  }

  const results: Array<{ externalId: string; ok: boolean; alreadyPresent?: boolean; error?: string }> = [];
  const { onExisting } = parsed.data;
  const topLevelId = parsed.data.collectionId || undefined;

  // Dedupe by externalId (first wins) so a double-selected card is one lot.
  const seen = new Set<string>();
  const cards = parsed.data.cards.filter((c) => !seen.has(c.externalId) && !!seen.add(c.externalId));

  // F-15: stamp explicit, strictly-decreasing addedAt values across the
  // batch (keyed by externalId) so the collection list — ordered by
  // `addedAt desc` — shows the batch at the FRONT in selection order,
  // rather than reversed by per-row now() defaults.
  const addedAtByExternalId = new Map(
    assignBulkAddOrder(cards.map((c) => c.externalId)).map((s) => [s.cardId, s.addedAt])
  );

  // Server-side ownership (RULE 5 — ownership by query scoping). We only file
  // a copy under a bucket the user actually OWNS.
  //  - top-level collectionId not owned → 404 before ANY write (identical to
  //    nonexistent, no id-enumeration leak).
  //  - per-item collectionId not owned → coerced to Main (no 4xx, no leak).
  // FAST PATH: with no collectionId anywhere, skip the owned-ids query.
  const anyCollectionId = !!topLevelId || cards.some((c) => !!c.collectionId);
  const owned = new Set<string>();
  if (anyCollectionId) {
    const rows = await prisma.collection.findMany({
      where: { userId },
      select: { id: true },
    });
    for (const r of rows) owned.add(r.id);
  }
  if (topLevelId && !owned.has(topLevelId)) {
    return NextResponse.json(
      { error: "Not Found", message: "Collection not found." },
      { status: 404 }
    );
  }

  // Main is resolved lazily, once, only when some item has no valid destination.
  // Legacy collectionId:null rows are untouched; new adds never write null.
  const requested = (c: (typeof cards)[number]) => c.collectionId || topLevelId;
  const needsMain = cards.some((c) => {
    const id = requested(c);
    return !id || !owned.has(id);
  });
  const mainId = needsMain ? (await getOrCreateMainCollection(userId)).id : null;

  for (const item of cards) {
    const want = requested(item);
    const effectiveCollectionId = want && owned.has(want) ? want : (mainId as string);
    try {
      const setName = item.setName?.trim() || "Unknown Set";
      const setExternalId = `user-added-${slugifySetName(setName)}`;

      const cardSet = await prisma.cardSet.upsert({
        where: { externalId: setExternalId },
        update: { name: setName },
        create: { externalId: setExternalId, name: setName },
      });

      // Look up card by externalId OR by id (in case externalId is passed as cuid)
      let card = await prisma.card.findFirst({
        where: {
          OR: [
            { externalId: item.externalId },
            { id: item.externalId },
          ],
        },
      });

      if (card) {
        // SECURITY (price fabrication / shared-catalog override): an ADD must
        // NEVER mutate a SHARED catalog row from user input. Card.marketPrice,
        // name, rarity, types, imageUrl are GLOBAL fields every user sees — a
        // user adding an existing catalog card previously overwrote them with
        // their own payload (poisoning search/trending/other dashboards, and
        // RULE 2 fabricating prices). We now reuse the existing `card` as-is
        // for the FK; its real price comes only from a Scrydex pull, never a
        // client add. (The user's own cost basis is kept on userCollection.)
      } else {
        // A genuinely new user-added card (not in the catalog) legitimately
        // needs metadata, but its PRICE must be null (RULE 2 — never fabricate;
        // a real price arrives later from a Scrydex pull, never client input).
        card = await prisma.card.create({
          data: {
            externalId: item.externalId,
            name: item.name,
            number: deriveCardNumber(item.externalId),
            rarity: item.rarity ?? "Unknown",
            types: item.types ?? [],
            imageUrl: item.imageUrl ?? null,
            marketPrice: null,
            lastPricedAt: null,
            setId: cardSet.id,
          },
        });
      }

      // Cost-basis capture (plan §5): prefer the user-entered price, else
      // SNAPSHOT the current price at add-time. Record the SOURCE + CURRENCY +
      // attempt timestamp so an unresolved basis (null) is distinguishable from
      // "never tried" and never silently becomes 0. We never fabricate a cost.
      // SECURITY: the snapshot fallback uses the REAL catalog price only — a
      // user-supplied item.marketPrice must not set even the user's own basis
      // ambiently (an EXPLICIT item.purchasePrice below is their own cost record
      // and is still honored).
      const snapshotPrice = card.marketPrice ?? null;
      let purchasePrice: number | null;
      let costBasisSource: string | null;
      if (item.purchasePrice != null) {
        purchasePrice = item.purchasePrice;
        costBasisSource = "user";
      } else if (snapshotPrice != null && snapshotPrice > 0) {
        purchasePrice = snapshotPrice;
        costBasisSource = "add-snapshot";
      } else {
        // No usable price → UNRESOLVED (null + attempt marker). A later price
        // fetch can lazily resolve it; until then P&L shows "unresolved".
        purchasePrice = null;
        costBasisSource = "unresolved";
      }
      const costBasisCurrency = purchasePrice != null ? "USD" : null;
      const costBasisAttemptedAt = new Date();
      const addedAt = addedAtByExternalId.get(item.externalId) ?? new Date();

      // Look for an existing active (not sold) copy of this card for the user,
      // scoped to the SAME variant: foil + specific collection + EXACT condition.
      //
      // F-#8: the app-side identity MUST key identically to the DB index
      // `uc_variant_coalesced` (COALESCE(condition,'')), so we compare on exact
      // normalized `condition` for EVERY lot (graded OR raw). A raw `null` lot and
      // a raw `"NM"` lot are therefore TWO distinct rows in both layers, and a
      // graded `"PSA 10"` lot stays distinct from both. (The old code matched the
      // first raw lot regardless of condition — looser than the index.)
      const norm = (c: string | null | undefined) => (c ?? "").trim().toUpperCase();

      const existingItems = await prisma.userCollection.findMany({
        where: {
          userId,
          cardId: card.id,
          isFoil: item.isFoil,
          isSold: false,
          collectionId: effectiveCollectionId,
        },
      });

      const existingItem = existingItems.find(
        (existing) => norm(existing.condition) === norm(item.condition)
      );

      if (existingItem && onExisting === "skip") {
        results.push({ externalId: item.externalId, ok: true, alreadyPresent: true });
        continue;
      }

      if (existingItem) {
        await prisma.userCollection.update({
          where: { id: existingItem.id },
          data: {
            quantity: existingItem.quantity + item.quantity,
            ...(item.condition ? { condition: item.condition } : {}),
            collectionId: effectiveCollectionId,
            // Only (re)set cost basis on an existing lot when the user supplied
            // one — don't overwrite a resolved basis with a fresh snapshot.
            ...(item.purchasePrice != null
              ? {
                  purchasePrice: item.purchasePrice,
                  costBasisSource: "user",
                  costBasisCurrency: "USD",
                  costBasisAttemptedAt,
                }
              : {}),
            addedAt,
          },
        });
      } else {
        try {
          await prisma.userCollection.create({
            data: {
              userId,
              cardId: card.id,
              quantity: item.quantity,
              isFoil: item.isFoil,
              condition: item.condition ?? null,
              purchasePrice,
              costBasisSource,
              costBasisCurrency,
              costBasisAttemptedAt,
              isSold: false,
              collectionId: effectiveCollectionId,
              addedAt,
            },
          });
        } catch (e) {
          // F-#8: a concurrent add raced past our findMany and created this exact
          // variant first → P2002 on `uc_variant_coalesced`. Re-read the raced lot
          // (same scoped find + exact-condition match) and increment it, so a race
          // resolves idempotently instead of becoming a user-visible failed card.
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
            const raced = await prisma.userCollection.findFirst({
              where: {
                userId,
                cardId: card.id,
                isFoil: item.isFoil,
                isSold: false,
                collectionId: effectiveCollectionId,
              },
            });
            const match = raced && norm(raced.condition) === norm(item.condition) ? raced : null;
            if (match && onExisting === "skip") {
              results.push({ externalId: item.externalId, ok: true, alreadyPresent: true });
              continue;
            } else if (match) {
              await prisma.userCollection.update({
                where: { id: match.id },
                data: { quantity: match.quantity + item.quantity },
              });
            } else {
              throw e; // not the race we expected → let the generic catch mark it failed
            }
          } else {
            throw e;
          }
        }
      }

      // FR-5 (design §5): capture ONE add-snapshot PricingHistory point so the
      // portfolio graph has a real datapoint from the moment a priced card is
      // added (the collection/history aggregation sums all sources per day).
      // Best-effort: wrapped so a snapshot failure NEVER fails the add (NFR-4).
      // A null/zero price writes NO row — never a fabricated $0 point (NFR-2).
      // SECURITY: this is a write to the SHARED pricing_history (the chart every
      // user sees) — the point MUST reflect the REAL catalog price at add time,
      // never a user-supplied item.marketPrice (price fabrication). If the real
      // price is null, no row is written (existing behavior).
      const addPrice = card.marketPrice;
      if (addPrice != null && addPrice > 0) {
        try {
          await prisma.pricingHistory.createMany({
            data: [
              {
                cardId: card.id,
                priceMarket: addPrice,
                source: "add-snapshot",
                variant: "normal",
                condition: "NM",
                currency: "USD",
                recordedAt: new Date(),
              },
            ],
            skipDuplicates: true,
          });
        } catch (snapErr) {
          console.warn(
            `[api/users/me/collection] add-snapshot failed for "${item.externalId}" (non-fatal):`,
            snapErr instanceof Error ? snapErr.message : snapErr
          );
        }
      }

      results.push({ externalId: item.externalId, ok: true });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : "Could not add this card.";
      console.error(
        `[api/users/me/collection] Failed to add card "${item.externalId}":`,
        errMsg
      );
      results.push({
        externalId: item.externalId,
        ok: false,
        error: errMsg,
      });
    }
  }

  // `added` = lots created/incremented; `alreadyPresent` = skipped by
  // onExisting:"skip"; `invalid` = items that failed. Only a batch where EVERY
  // item failed is a 5xx (an all-already-present skip batch is a success).
  const addedCount = results.filter((r) => r.ok && !r.alreadyPresent).length;
  const alreadyPresentCount = results.filter((r) => r.alreadyPresent).length;
  const invalidCount = results.filter((r) => !r.ok).length;
  const allFailed = invalidCount === results.length;

  // Invalidate the per-user caches this add feeds (best-effort, after the DB
  // writes committed): collection:{userId} + dashboard:{userId}. Skip when
  // nothing was actually added.
  if (addedCount > 0) {
    await invalidateUserCaches(userId, ["collection", "dashboard", "collections"]);
  }

  return NextResponse.json(
    {
      message: allFailed ? (results[0]?.error ?? "Could not add this card.") : undefined,
      added: addedCount,
      alreadyPresent: alreadyPresentCount,
      invalid: invalidCount,
      total: results.length,
      results,
    },
    { status: allFailed ? 500 : 200 }
  );
}
