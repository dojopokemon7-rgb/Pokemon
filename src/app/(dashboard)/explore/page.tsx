/**
 * /explore — redirect alias for /search
 *
 * The Dojo prototype's tab bar labels the fourth tab "Explore" but its
 * actual A.tab handler maps `explore -> 'search'` (see
 * dashboard-client-shell.tsx for the full citation) — there is no
 * separate Explore screen in the reference. The bottom nav already
 * links directly to /search for that reason.
 *
 * This route exists only so a bookmarked or typed /explore URL doesn't
 * 404 — it immediately redirects to /search, preserving any query
 * string (so /explore?q=charizard still works as expected).
 */

import { redirect } from "next/navigation";

export default async function ExplorePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") qs.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) qs.set(key, value[0]);
  }
  const suffix = qs.toString();
  redirect(suffix ? `/search?${suffix}` : "/search");
}
