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
import DashboardClient, {
  type CollectionItem,
} from "./_components/DashboardClient";

export default async function DashboardPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");

  // Same shape as `/api/users/me/collection` returns, minus the
  // fields the dashboard never reads (notes, condition, addedAt,
  // etc.). Kept narrow so we ship the smallest payload possible
  // during SSR.
  const rows = await prisma.userCollection.findMany({
    where: { userId: session.user.id },
    orderBy: { addedAt: "desc" },
    select: {
      id: true,
      cardId: true,
      quantity: true,
      isFoil: true,
      purchasePrice: true,
      card: {
        select: {
          id: true,
          name: true,
          marketPrice: true,
          set: { select: { name: true } },
        },
      },
    },
  });

  const initialItems: CollectionItem[] = rows;

  const firstName =
    session.user.name?.split(" ")[0]?.toLowerCase() ?? "collector";

  return (
    <DashboardClient firstName={firstName} initialItems={initialItems} />
  );
}
