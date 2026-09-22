import { test, expect } from "@playwright/test";

/**
 * F-04 — Duplicate cards on "Show More". RED phase.
 *
 * Runs under the `authed` project (real server-trusted session via
 * storageState) against the real backend + Supabase.
 *
 * Requirement: clicking "Show More" on the Explore/Search grid must
 * APPEND a fresh page of cards — never re-show cards already on screen.
 *
 * The default Explore view is the "Trending" ranking, which returns a
 * single curated page (no pagination). "Show More" only appears once the
 * user picks a paginating sort, so the test switches Sort → "Name · A to
 * Z" to exercise the real pagination path.
 *
 * EXPECTED TO FAIL today: the trending route only honours the keyset
 * cursor when sort === "recent" (`effectiveCursor = sort === "recent" ?
 * cursor : undefined`). For every other paginating sort (name_asc,
 * market_*), it IGNORES the cursor and re-runs page 1 — yet still returns
 * a nextCursor, so "Show More" appears and clicking it appends PAGE 1
 * AGAIN. Result: every card on the first page is duplicated.
 *
 * Identity per tile: the card image `src` (when present) combined with
 * the tile's visible text (name · set · price). A duplicated card renders
 * an identical tile, so identical identity strings = duplicates; two
 * different cards that merely share a name won't collide (set/price differ).
 */

/** Reads a stable-ish identity for every visible card-result tile. */
async function tileIdentities(page: import("@playwright/test").Page): Promise<string[]> {
  return page.locator('[data-testid="card-result"]').evaluateAll((tiles) =>
    tiles.map((el) => {
      const img = el.querySelector("img");
      const src = img?.getAttribute("src") ?? "";
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      return `${src}||${text}`;
    })
  );
}

test.describe("F-04 Show More pagination", () => {
  test("clicking Show More appends new cards with zero duplicates", async ({ page }) => {
    await page.goto("/search");

    // Switch to a paginating sort so "Show More" is available. (Trending —
    // the default — is a single curated page with no pagination.) "Name ·
    // A to Z" paginates AND is a sort whose cursor the route mishandles,
    // which is exactly the duplicate bug under test.
    await page.getByRole("button", { name: /^sort$/i }).click();
    await page.getByRole("button", { name: /name .* a to z/i }).click();

    // Initial grid.
    const tiles = page.locator('[data-testid="card-result"]');
    await expect(tiles.first()).toBeVisible({ timeout: 30_000 });
    const initialCount = await tiles.count();
    expect(initialCount).toBeGreaterThan(0);

    // Load the next page.
    const showMore = page.getByRole("button", { name: /show more/i });
    await expect(showMore).toBeVisible();
    await showMore.click();

    // Wait until the grid has grown beyond the initial count.
    await expect
      .poll(async () => tiles.count(), { timeout: 15_000 })
      .toBeGreaterThan(initialCount);

    const totalCount = await tiles.count();
    const identities = await tileIdentities(page);
    const uniqueCount = new Set(identities).size;

    // Grid grew…
    expect(totalCount).toBeGreaterThan(initialCount);
    // …and every tile on screen is a distinct card (no duplicates).
    expect(uniqueCount).toBe(totalCount);
  });
});
