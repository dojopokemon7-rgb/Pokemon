import { test, expect, type Locator } from "@playwright/test";

/**
 * F-06 — Folder / Set Filters. RED phase.
 *
 * Runs under the `authed` project (real server-trusted session via
 * storageState) against the real backend + Supabase (Prisma / Better Auth).
 *
 * Target behaviour (the end state these tests pin, NOT yet built):
 *   On the Explore/Search results page a user can filter the visible cards
 *   by SET (folder/category). Picking a set narrows the grid to only that
 *   set and reflects the choice in the URL (?set=…); clearing it restores
 *   the full result list.
 *
 * Selector contract for the GREEN phase:
 *   - A set filter control exposed as a combobox with accessible name
 *     matching /set/i (e.g. a "Filter by set" <select>) OR a control with
 *     data-testid="set-filter". It offers an "All sets" option plus one
 *     option per set present in the results.
 *   - Applying a set updates the URL to carry ?set=<something> AND narrows
 *     the grid so every visible card-result belongs to that set.
 *   - Selecting "All sets" (or clearing) removes ?set= and restores the
 *     full list.
 *
 * EXPECTED TO FAIL today: the only filter control on /search is the Sort
 * sheet (Trending/Recent/Market/Name). There is no set filter — neither a
 * UI control nor a `set` param on /api/cards/search (see the route's Zod
 * schema: game/query/sort only, with an explicit "Set dropdown … Skipped"
 * TODO in the FilterSheet). So no /set combobox exists to interact with.
 */

const QUERY = "charizard"; // real-TCG catalog: Charizard spans several sets

/** The set label rendered on a result tile. GREEN phase should expose it
 *  via data-testid="card-result-set"; until then, fall back to the tile's
 *  set text line so this helper still resolves a value in the RED phase. */
async function tileSet(tile: Locator): Promise<string> {
  const tagged = tile.getByTestId("card-result-set");
  if (await tagged.count()) return (await tagged.innerText()).trim();
  // Fallback: the set is the second non-empty text line (name, set, price).
  const raw = (await tile.innerText()).split("\n").map((s) => s.trim()).filter(Boolean);
  return raw[1] ?? "";
}

/** Locate the set filter control (contract: combobox named /set/i, or a
 *  data-testid="set-filter"). */
function setFilter(page: import("@playwright/test").Page): Locator {
  return page
    .getByRole("combobox", { name: /set/i })
    .or(page.getByTestId("set-filter"));
}

test.describe("F-06 Folder / Set Filters", () => {
  test("filtering by a set narrows the grid to that set and updates the URL", async ({ page }) => {
    await page.goto(`/search?q=${encodeURIComponent(QUERY)}`);

    const results = page.getByTestId("card-result");
    await expect(results.first()).toBeVisible({ timeout: 30_000 });
    // The set filter control only appears once results (and their sets) are
    // in — also a good hydration gate before we interact with it.
    const filter = setFilter(page);
    await expect(filter).toBeVisible({ timeout: 30_000 });

    // Target set = the set of the first result.
    const targetSet = await tileSet(results.first());
    expect(targetSet.length, "no set label on the first result").toBeGreaterThan(0);

    // Apply the set filter (contract: a combobox named /set/i).
    await filter.selectOption({ label: targetSet });

    // Assertion 1: the URL reflects the active set filter.
    await expect(page).toHaveURL(/[?&]set=/);

    // Wait for the filtered refetch to settle (the "Searching…" skeleton
    // clears) before counting — otherwise we read a transient 0.
    await expect(results.first()).toBeVisible();
    // Assertion 2: every visible tile now belongs to the selected set.
    // Poll so we compare against the settled, post-refetch grid.
    await expect
      .poll(async () => {
        const n = await results.count();
        if (n === 0) return false;
        for (let i = 0; i < n; i++) {
          if ((await tileSet(results.nth(i))) !== targetSet) return false;
        }
        return true;
      }, { timeout: 10_000 })
      .toBe(true);
  });

  test("clearing the set filter restores the full result list", async ({ page }) => {
    await page.goto(`/search?q=${encodeURIComponent(QUERY)}`);

    const results = page.getByTestId("card-result");
    await expect(results.first()).toBeVisible({ timeout: 30_000 });
    const filter = setFilter(page);
    await expect(filter).toBeVisible({ timeout: 30_000 });
    const unfilteredCount = await results.count();

    const targetSet = await tileSet(results.first());
    await filter.selectOption({ label: targetSet });
    await expect(page).toHaveURL(/[?&]set=/);
    // Let the filtered refetch settle before measuring.
    await expect(results.first()).toBeVisible();
    await expect.poll(async () => results.count(), { timeout: 10_000 })
      .toBeLessThanOrEqual(unfilteredCount);

    // Clear the filter → "All sets" (the empty-value clear option) → full
    // list returns.
    await filter.selectOption("");
    await expect(page).not.toHaveURL(/[?&]set=/);
    await expect(results).toHaveCount(unfilteredCount);
  });
});
