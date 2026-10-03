/**
 * GET  /api/users/me/collection — fetch the authenticated user's collection.
 * POST /api/users/me/collection — add one or more cards to it.
 *
 * Uses requireAuth guard to enforce authentication on both.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/utils/auth-guard";
import { prisma } from "@/lib/db";
import { assignBulkAddOrder } from "@/lib/utils/bulk-add-order";

export async function GET(request: Request): Promise<NextResponse> {
  const guard = await requireAuth(request);
  if (guard.unauthorized) return guard.unauthorized;

  const { session } = guard;
  const userId = session.user.id;

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
            set: { select: { id: true, name: true } },
          },
        },
      },
    });

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
  marketPrice: z.number().nullable().optional(),
  quantity: z.number().int().min(1).max(999).default(1),
  isFoil: z.boolean().default(false),
  condition: z.string().trim().optional(),
  // Price the user actually paid — defaults to the card's current
  // market price if omitted (a reasonable default, not a fabricated one).
  purchasePrice: z.number().nullable().optional(),
  // F-10: file this copy under a named collection (null/omitted = Main /
  // uncategorized). The Add sheet's COLLECTION dropdown sets it.
  collectionId: z.string().trim().optional(),
});

const AddCollectionRequestSchema = z.object({
  cards: z.array(AddCardSchema).min(1).max(50),
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

  const results: Array<{ externalId: string; ok: boolean; error?: string }> = [];

  // F-15: stamp explicit, strictly-decreasing addedAt values across the
  // batch (keyed by externalId) so the collection list — ordered by
  // `addedAt desc` — shows the batch at the FRONT in selection order,
  // rather than reversed by per-row now() defaults.
  const addedAtByExternalId = new Map(
    assignBulkAddOrder(parsed.data.cards.map((c) => c.externalId)).map((s) => [
      s.cardId,
      s.addedAt,
    ])
  );

  for (const item of parsed.data.cards) {
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
        card = await prisma.card.update({
          where: { id: card.id },
          data: {
            name: item.name,
            ...(item.rarity ? { rarity: item.rarity } : {}),
            ...(item.types ? { types: item.types } : {}),
            ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
            ...(item.marketPrice != null
              ? { marketPrice: item.marketPrice, lastPricedAt: new Date() }
              : {}),
          },
        });
      } else {
        card = await prisma.card.create({
          data: {
            externalId: item.externalId,
            name: item.name,
            number: deriveCardNumber(item.externalId),
            rarity: item.rarity ?? "Unknown",
            types: item.types ?? [],
            imageUrl: item.imageUrl ?? null,
            marketPrice: item.marketPrice ?? null,
            lastPricedAt: item.marketPrice != null ? new Date() : null,
            setId: cardSet.id,
          },
        });
      }

      // Cost-basis capture (plan §5): prefer the user-entered price, else
      // SNAPSHOT the current price at add-time. Record the SOURCE + CURRENCY +
      // attempt timestamp so an unresolved basis (null) is distinguishable from
      // "never tried" and never silently becomes 0. We never fabricate a cost.
      const snapshotPrice = item.marketPrice ?? card.marketPrice ?? null;
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

      // Look for an existing active (not sold) copy of this card for the user
      // Respect graded condition vs raw and specific collection
      const GRADED_RE = /\b(psa|bgs|cgc|sgc|beckett)\b/i;
      const isItemGraded = !!item.condition && GRADED_RE.test(item.condition);

      const existingItems = await prisma.userCollection.findMany({
        where: {
          userId,
          cardId: card.id,
          isFoil: item.isFoil,
          isSold: false,
          collectionId: item.collectionId ?? null,
        },
      });

      const existingItem = existingItems.find((existing) => {
        const isExistingGraded = !!existing.condition && GRADED_RE.test(existing.condition);
        if (isItemGraded || isExistingGraded) {
          return (existing.condition ?? "").trim().toUpperCase() === (item.condition ?? "").trim().toUpperCase();
        }
        return true;
      });

      if (existingItem) {
        await prisma.userCollection.update({
          where: { id: existingItem.id },
          data: {
            quantity: existingItem.quantity + item.quantity,
            ...(item.condition ? { condition: item.condition } : {}),
            collectionId: item.collectionId ?? null,
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
            collectionId: item.collectionId ?? null,
            addedAt,
          },
        });
      }

      // FR-5 (design §5): capture ONE add-snapshot PricingHistory point so the
      // portfolio graph has a real datapoint from the moment a priced card is
      // added (the collection/history aggregation sums all sources per day).
      // Best-effort: wrapped so a snapshot failure NEVER fails the add (NFR-4).
      // A null/zero price writes NO row — never a fabricated $0 point (NFR-2).
      const addPrice = item.marketPrice ?? card.marketPrice;
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

  const addedCount = results.filter((r) => r.ok).length;
  const allFailed = addedCount === 0;

  return NextResponse.json(
    {
      message: allFailed ? (results[0]?.error ?? "Could not add this card.") : undefined,
      added: addedCount,
      total: results.length,
      results,
    },
    { status: allFailed ? 500 : 200 }
  );
}
