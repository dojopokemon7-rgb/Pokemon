import { test, expect, request as apiRequest } from "@playwright/test";
import { STORAGE_STATE } from "./constants";

/**
 * F-08 — Card Details Popup (Home only).
 *
 * Runs under the `authed` project (real server-trusted session via
 * storageState) against the real backend + Supabase.
 *
 * Behaviour pinned here:
 *   - HOME (/dashboard): clicking a card tile opens an in-place details
 *     MODAL/POPUP (animated), NOT a navigation to a separate page. The
 *     popup shows the image, price, grade/condition, and Add to Collection
 *     / Want to Buy actions, and closes via the X or a backdrop click.
 *   - EXPLORE (/search): the intermediate quick-view popup was REMOVED.
 *     Tapping a card now navigates directly to the full card detail page
 *     (/search/[id]).
 *
 * Selector contract:
 *   - The popup root exposes role="dialog" AND data-testid="card-details-popup".
 *   - The close control is a button named /close/i.
 *   - The backdrop/scrim exposes data-testid="card-details-backdrop".
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

    test("Home: clicking a card opens the details popup", async ({ page }) => {
      await page.goto("/dashboard");

      // Home surfaces card tiles (most-valuable rows). Open the first.
      const firstCard = page.getByTestId("card-result").first();
      await expect(firstCard).toBeVisible();
      await firstCard.click();

      const popup = page.getByTestId("card-details-popup");
      await expect(popup).toBeVisible();
      // Opened in place — no navigation away from the dashboard.
      await expect(page).toHaveURL(/\/dashboard(\?|$)/);
      // Both add actions are present in the popup.
      await expect(popup.getByRole("button", { name: /add to collection/i })).toBeVisible();
      await expect(popup.getByRole("button", { name: /want to buy/i })).toBeVisible();
    });

    test("Home: the X button closes the popup", async ({ page }) => {
      await page.goto("/dashboard");
      const firstCard = page.getByTestId("card-result").first();
      await expect(firstCard).toBeVisible();
      await firstCard.click();

      const popup = page.getByTestId("card-details-popup");
      await expect(popup).toBeVisible();
      await popup.getByRole("button", { name: /close/i }).click();
      await expect(popup).toBeHidden();
      await expect(page).toHaveURL(/\/dashboard(\?|$)/);
    });

    test("Home: clicking outside (backdrop) closes the popup", async ({ page }) => {
      await page.goto("/dashboard");
      const firstCard = page.getByTestId("card-result").first();
      await expect(firstCard).toBeVisible();
      await firstCard.click();

      const popup = page.getByTestId("card-details-popup");
      await expect(popup).toBeVisible();
      await page.getByTestId("card-details-backdrop").click({ position: { x: 5, y: 5 } });
      await expect(popup).toBeHidden();
      await expect(page).toHaveURL(/\/dashboard(\?|$)/);
    });
  });
});
