/**
 * Screen 09 + 10 — Dashboard (server-rendered shell)
 *
 * Server component. Fetches the user's session + collection directly
 * from Prisma so the first byte to the browser already contains the
 * data, then hands off to DashboardClient for all interactivity
 * (tabs, ranges, hidden toggle, chart re-renders on state change).
 *
 * Previously the whole page was a client component that ran a
 * `useQuery(["collection"])` on mount — that meant every visit
 * sent an empty HTML shell, hydrated on the client, THEN fetched
 * data over the network before showing any numbers. This variant
 * removes that extra round-trip and the loading flash.
 *
 * The `(dashboard)/layout.tsx` already gates auth + admin redirects,
 * so if we've reached this file we know we have a valid non-admin
 * session — but we still fall through to /login defensively if the
 * session somehow disappears between layout and page render.
 */

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getServerSession } from "@/lib/utils/get-server-session";
import { RedisKeys, CACHE_TTL } from "@/lib/redis";
import { cacheGetJson, cacheSetJson } from "@/lib/utils/cache";
import DashboardClient, {
  type CollectionItem,
} from "./_components/DashboardClient";

/** Cached SSR payload: the dashboard reads owned rows + named collections. */
type DashboardCache = {
  rows: CollectionItem[];
  collections: { id: string; name: string }[];
};

export default async function DashboardPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");

  // Per-user SSR cache (RULE 5 — key embeds userId; a cache fault falls
  // through to the live Prisma reads via the helper, so SSR never blocks or
  // throws on Redis). INVALIDATED BY: add/sell/update/delete collection item,
  // want-list add/move/remove, and collection create/rename/delete.
  const cacheKey = RedisKeys.dashboardData(session.user.id);
  const cached = await cacheGetJson<DashboardCache>(cacheKey);

  // Same shape as `/api/users/me/collection` returns, minus the
  // fields the dashboard never reads (notes, condition, addedAt,
  // etc.). Kept narrow so we ship the smallest payload possible
  // during SSR.
  const [rows, collections] = cached
    ? [cached.rows, cached.collections]
    : await Promise.all([
    prisma.userCollection.findMany({
      where: { userId: session.user.id },
      orderBy: { addedAt: "desc" },
      select: {
        id: true,
        cardId: true,
        quantity: true,
        isFoil: true,
        purchasePrice: true,
        // Free-text grade/condition — used to count graded cards per
        // collection on the dashboard Collections tab ("… · N graded").
        condition: true,
        // F-11: which named collection this owned copy is filed under
        // (null = uncategorized). Drives the dashboard collection selector.
        collectionId: true,
        isSold: true,
        soldPrice: true,
        soldAt: true,
        card: {
          select: {
            id: true,
            externalId: true,
            name: true,
            marketPrice: true,
            set: { select: { name: true } },
          },
        },
      },
    }),
    // Named collections for the selector dropdown.
    prisma.collection.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true },
    }),
  ]);

  // Best-effort cache fill on a miss (helper swallows Redis errors). Date
  // fields serialize to ISO strings over JSON — the client already consumes
  // that same API JSON shape, so the cached form reproduces it exactly.
  if (!cached) {
    await cacheSetJson(cacheKey, { rows, collections }, CACHE_TTL.dashboard);
  }

  const initialItems: CollectionItem[] = rows;

  const firstName =
    session.user.name?.split(" ")[0]?.toLowerCase() ?? "collector";

  return (
    <DashboardClient
      firstName={firstName}
      initialItems={initialItems}
      collections={collections}
    />
  );
}
