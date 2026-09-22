import { test, expect } from "@playwright/test";

/**
 * F-05 — Search Suggestions (Debounce). RED phase.
 *
 * Runs under the `authed` project (real server-trusted session via
 * storageState) against the real backend + Supabase (Prisma / Better Auth).
 *
 * Target behaviour (the end state these tests pin, NOT yet built):
 *   Typing into the Explore search box searches AS YOU TYPE, but the input
 *   is DEBOUNCED — a burst of keystrokes ("charizard") collapses into a
 *   single (or very few) call(s) to /api/cards/search once the user pauses,
 *   and the results grid then populates without pressing Enter.
 *
 * EXPECTED TO FAIL today: the search box only fires on form submit (Enter).
 * Typing updates local state but issues NO /api/cards/search request, so
 *   - the request count stays at 0 (never the expected ~1), and
 *   - the results never populate from typing alone.
 * There is no debounce because there is no as-you-type search at all.
 */

const QUERY = "charizard";

test.describe("F-05 Search Debounce", () => {
  test("a burst of keystrokes collapses into a single debounced search call", async ({ page }) => {
    // Count search requests by OBSERVING traffic (page.on) rather than
    // intercepting — no glob/route ambiguity, and it can't accidentally
    // swallow the request.
    let searchCalls = 0;
    const countSearch = (req: import("@playwright/test").Request) => {
      if (req.url().includes("/api/cards/search")) searchCalls += 1;
    };
    page.on("request", countSearch);

    await page.goto("/search");

    // Wait until the page is interactive (trending grid rendered ⇒ React
    // hydrated and the input's onChange is wired) before typing — under
    // parallel load, typing pre-hydration lands characters with no handler
    // attached, so no debounced search would ever schedule.
    await expect(page.getByTestId("card-result").first()).toBeVisible({ timeout: 30_000 });
    // The trending grid uses /api/cards/trending, not /search; start clean.
    searchCalls = 0;

    // Type the whole query fast (no per-key pause) so a per-keystroke
    // implementation would fire ~9 requests; a debounced one fires ~1.
    const input = page.getByRole("searchbox", { name: /search cards/i });
    await input.click();
    await input.pressSequentially(QUERY, { delay: 20 });

    // Let the debounce window elapse (typical 300–500ms) plus slack.
    await page.waitForTimeout(700);
    page.off("request", countSearch);

    // Debounced: the burst should have produced at most a couple of calls,
    // NOT one per character. (A per-keystroke impl fires ~9; no-search
    // fires 0 — both fail this "fired, but debounced" contract.)
    expect(searchCalls, `expected ~1 debounced search call, got ${searchCalls}`).toBeGreaterThan(0);
    expect(searchCalls, `search not debounced — ${searchCalls} calls for a ${QUERY.length}-char burst`).toBeLessThanOrEqual(2);
  });

  test("results populate after the debounce delay without pressing Enter", async ({ page }) => {
    await page.goto("/search");

    // Wait for hydration (trending grid rendered) before typing so the
    // onChange handler is attached — see the debounce-count test above.
    await expect(page.getByTestId("card-result").first()).toBeVisible({ timeout: 30_000 });

    const input = page.getByRole("searchbox", { name: /search cards/i });
    await input.click();
    await input.pressSequentially(QUERY, { delay: 20 });

    // No Enter / submit — the debounced live search must populate results.
    // (Trending also renders card-result tiles; wait for the SEARCH results
    // specifically by asserting a Charizard tile appears.)
    await expect(
      page.getByTestId("card-result").filter({ hasText: /charizard/i }).first()
    ).toBeVisible({ timeout: 5000 });
  });
});
