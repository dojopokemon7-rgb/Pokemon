import { test, expect, request as apiRequest } from "@playwright/test";
import { STORAGE_STATE } from "./constants";

/**
 * F-08 — Card row navigation (Home + Explore).
 *
 * Runs under the `authed` project (real server-trusted session via
 * storageState) against the real backend + Supabase.
 *
 * Behaviour pinned here:
 *   - HOME (/dashboard): clicking a card row NAVIGATES to the full card
 *     detail page (/search/[id]) — the in-place quick-view popup was
 *     REMOVED (design violation: it should open the full detail page, like
 *     the Explore tiles).
 *   - EXPLORE (/search): tapping a card likewise navigates directly to the
 *     full card detail page (/search/[id]).
 *
 * Selector contract:
 *   - Card rows/tiles expose data-testid="card-result".
 *   - The removed popup's data-testid="card-details-popup" must stay hidden.
 */

test.describe("F-08 Card Details Popup", () => {
  test("Explore: tapping a card navigates directly to the card detail page (no popup)", async ({ page }) => {
    // Plain goto (default "load"): the trending grid keeps polling prices so
    // `networkidle` never settles; wait on the tiles appearing instead.
    await page.goto("/search");

    const firstCard = page.getByTestId("card-result").first();
    await expect(firstCard).toBeVisible({ timeout: 30_000 });
    await firstCard.click();

    // Direct navigation to /search/[id] — no in-place quick-view modal.
    await expect(page).toHaveURL(/\/search\/[^/?]+(\?|$)/);
    await expect(page.getByTestId("card-details-popup")).toBeHidden();
  });

  // The dashboard only renders card rows (Most Valuable / Gainers /
  // Losers) once the account owns at least one card. The shared authed
  // test account starts empty, so seed one card via the real API before
  // this test and remove it after, leaving the DB as we found it.
  test.describe("Home (with a seeded card)", () => {
    const SEED_EXTERNAL_ID = `e2e-f08-${Date.now()}`;

    test.beforeAll(async () => {
      const ctx = await apiRequest.newContext({
        baseURL: "http://localhost:3001",
        storageState: STORAGE_STATE,
      });
      try {
        await ctx.post("/api/users/me/collection", {
          data: {
            cards: [
              {
                externalId: SEED_EXTERNAL_ID,
                name: "F08 Popup Test Card",
                setName: "E2E Set",
                marketPrice: 42.5,
                quantity: 1,
                isFoil: false,
              },
            ],
          },
        });
      } finally {
        await ctx.dispose();
      }
    });

    test.afterAll(async () => {
      const ctx = await apiRequest.newContext({
        baseURL: "http://localhost:3001",
        storageState: STORAGE_STATE,
      });
      try {
        const res = await ctx.get("/api/users/me/collection");
        if (res.ok()) {
          const { items } = await res.json();
          for (const item of (items ?? []) as { id: string; card?: { name?: string } }[]) {
            if (item.card?.name === "F08 Popup Test Card") {
              await ctx.delete(`/api/users/me/collection/${item.id}`);
            }
          }
        }
      } finally {
        await ctx.dispose();
      }
    });

    test("Home: clicking a card navigates directly to the card detail page (no popup)", async ({ page }) => {
      await page.goto("/dashboard");

      // Home surfaces card rows (most-valuable). Click the first.
      const firstCard = page.getByTestId("card-result").first();
      await expect(firstCard).toBeVisible();
      await firstCard.click();

      // Direct navigation to /search/[id] — no in-place quick-view modal.
      await expect(page).toHaveURL(/\/search\/[^/?]+(\?|$)/);
      await expect(page.getByTestId("card-details-popup")).toBeHidden();
    });
  });
});
