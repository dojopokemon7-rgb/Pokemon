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
import { buildCollectionHistories } from "@/lib/services/collection-history.service";
import { UNCAT_ID, toHistoryToken, defaultSelectorIds } from "@/lib/utils/collection-ids";
import DashboardClient, {
  type CollectionItem,
} from "./_components/DashboardClient";

/** The chart's first-render default range (mirrors DashboardClient's
 *  `useState<RangeId>("1M")`). SSR MUST use this exact value or the client's
 *  first query key won't match and the SSR data won't hydrate. */
const DEFAULT_RANGE = "1M";

/** Per-collection value histories keyed by the client's bucket id. */
type Histories = Record<string, { date: string; value: number | null }[]>;

/**
 * Cached SSR payload: the dashboard reads owned rows + named collections, PLUS
 * the DEFAULT-range chart histories so the comparison chart arrives with the
 * first byte (no post-mount fetch, no skeleton flash). Folded into the SAME
 * per-user `dashboard:<userId>` key — already per-user, 90s TTL, and already
 * invalidated by every mutation that changes collection value — rather than a
 * new key that would need its own invalidation wiring.
 */
type DashboardCache = {
  rows: CollectionItem[];
  collections: { id: string; name: string }[];
  histories?: Histories; // optional: legacy entries written before this field
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
            imageUrl: true,
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

  // The client's first-render chart query uses the DEFAULT selection (empty
  // `selectedIds` → "all options") expanded to the collOptions id list, which
  // is the loose/uncategorized bucket sentinel "__uncat__" FIRST, then each
  // named collection in `collectionList` order. `collectionIdsQuery` is that
  // list `.join(",")`. We MUST compute the identical list + range here so the
  // SSR query key matches the client's first ["portfolio-history",
  // collectionIdsQuery, activeRange] key and the data hydrates (else no match
  // → undefined → the normal fetch runs). See collection-history.service.ts
  // for why the loose bucket needs the service token "null" (not the UI
  // sentinel "__uncat__"). We translate "__uncat__" → "null" here via the SAME
  // shared helper the client uses, so `initialCollectionIdsQuery` is
  // byte-identical to the client's new `collectionIdsQuery` AND the service
  // actually plots the loose/uncategorized bucket.
  // FEAT-004: "__uncat__" is included only while some lot is still unassigned;
  // the client builds its list through the SAME defaultSelectorIds helper.
  const defaultCollectionIds = defaultSelectorIds(collections.map((c) => c.id), rows).map(
    toHistoryToken
  );
  const initialCollectionIdsQuery = defaultCollectionIds.join(",");

  // Default chart histories. Reuse a cached `histories` map ONLY if it is
  // already keyed by the new tokens — a pre-fix 90s-TTL entry still keyed by
  // "__uncat__" (the loose-bucket bug) is treated as a miss and rebuilt, else a
  // stale hit would re-serve an empty loose-cards series after this fix ships.
  // Also guards legacy entries written before `histories` existed (undefined).
  // Prisma-only, ZERO credits — the Scrydex credit gate is untouched.
  const cachedHistories =
    cached?.histories && !(UNCAT_ID in cached.histories)
      ? cached.histories
      : undefined;
  const rebuilt = cachedHistories === undefined;
  const histories: Histories =
    cachedHistories ??
    (await buildCollectionHistories(
      session.user.id,
      defaultCollectionIds,
      DEFAULT_RANGE
    ));

  // Best-effort cache fill on a miss OR when a stale-shape hit was rebuilt
  // (helper swallows Redis errors), so the corrected `histories` shape
  // overwrites the stale entry instead of self-healing only in memory. Date
  // fields serialize to ISO strings over JSON — the client already consumes
  // that same API JSON shape, so the cached form reproduces it exactly.
  if (!cached || rebuilt) {
    await cacheSetJson(
      cacheKey,
      { rows, collections, histories },
      CACHE_TTL.dashboard
    );
  }

  const initialItems: CollectionItem[] = rows;

  const firstName =
    session.user.name?.split(" ")[0]?.toLowerCase() ?? "collector";

  return (
    <DashboardClient
      firstName={firstName}
      initialItems={initialItems}
      collections={collections}
      // SSR chart data: the queryFn resolves to `{ histories }`, so we pass the
      // SAME wrapper shape as `initialData` — hydrated only when the live key
      // matches (initialCollectionIdsQuery + initialRange) in DashboardClient.
      initialHistories={{ histories }}
      initialRange={DEFAULT_RANGE}
      initialCollectionIdsQuery={initialCollectionIdsQuery}
    />
  );
}
