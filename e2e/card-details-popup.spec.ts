import { test, expect, request as apiRequest } from "@playwright/test";
import { STORAGE_STATE } from "./constants";

/**
 * F-08 — Card Details Popup.
 *
 * Runs under the `authed` project (real server-trusted session via
 * storageState) against the real backend + Supabase.
 *
 * Target behaviour (the end state these tests pin, NOT yet built):
 *   Clicking a card tile on Home (/dashboard) or Explore (/search) opens
 *   an in-place details MODAL/POPUP (animated), rather than navigating to
 *   a separate /search/[id] detail page. The popup must show:
 *     - the card image
 *     - price(s)
 *     - the card grade / condition
 *     - an "Add to Collection" action
 *     - an "Add to Favourites" action
 *   and must close via a close (X) button OR an outside/backdrop click,
 *   returning focus to the underlying page (no navigation happened).
 *
 * EXPECTED TO FAIL today: clicking a card navigates to /search/[id]
 * (a full page), so no dialog/modal with role="dialog" (or the
 * data-testid="card-details-popup" hook) ever appears in place.
 *
 * Selector contract for the GREEN phase:
 *   - The popup root exposes role="dialog" AND data-testid="card-details-popup".
 *   - The close control is a button with an accessible name matching /close/i.
 *   - The backdrop/scrim exposes data-testid="card-details-backdrop".
 *   - Add actions are buttons named /add to collection/i and
 *     /add to (favourites|favorites)/i.
 */

// The scenarios are independent (each opens a fresh popup), so no serial
// mode is needed — but keep them in one describe for reporting clarity.
test.describe("F-08 Card Details Popup", () => {
  test("Explore: clicking a card opens the details popup with full content", async ({ page }) => {
    // Plain goto (default "load"): `networkidle` never settles here because
    // the trending grid keeps polling prices (and Redis/eBay calls retry),
    // so we wait on the tiles appearing instead — the signal that matters.
    await page.goto("/search");

    // Open the first trending/search card tile. The trending feed reads
    // the seeded catalog from Postgres (Redis is a non-fatal cache that
    // falls through when down), but the first cold fetch under parallel
    // load can be slow — allow extra time for the tile rather than relying
    // on a retry.
    const firstCard = page.getByTestId("card-result").first();
    await expect(firstCard).toBeVisible({ timeout: 30_000 });
    await firstCard.click();

    // A modal/popup must open in place (NOT a navigation to /search/[id]).
    const popup = page.getByRole("dialog").filter({
      has: page.getByTestId("card-details-popup"),
    }).or(page.getByTestId("card-details-popup"));
    await expect(popup).toBeVisible();

    // We must still be on the Explore page — the popup opens in place.
    await expect(page).toHaveURL(/\/search(\?|$)/);

    // Content: image, price, grade, and both add actions.
    await expect(popup.getByRole("img")).toBeVisible();
    // A price is rendered somewhere in the popup ("$" amount or an em dash).
    await expect(popup.getByText(/\$\s?\d|—/).first()).toBeVisible();
    // Grade / condition label (e.g. "Raw", "Ungraded", "PSA 10", "Graded").
    await expect(
      popup.getByText(/\b(raw|ungraded|graded|psa|bgs|cgc|grade)\b/i).first()
    ).toBeVisible();
    // Both add actions.
    await expect(popup.getByRole("button", { name: /add to collection/i })).toBeVisible();
    await expect(
      popup.getByRole("button", { name: /add to (favourites|favorites)/i })
    ).toBeVisible();
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
    });
  });

  test("Close: the X button closes the popup and returns to the page", async ({ page }) => {
    await page.goto("/search");
    const firstCard = page.getByTestId("card-result").first();
    await expect(firstCard).toBeVisible({ timeout: 30_000 });
    await firstCard.click();

    const popup = page.getByTestId("card-details-popup");
    await expect(popup).toBeVisible();

    await popup.getByRole("button", { name: /close/i }).click();

    // Popup gone, still on Explore, underlying page interactive again.
    await expect(popup).toBeHidden();
    await expect(page).toHaveURL(/\/search(\?|$)/);
    await expect(page.getByTestId("card-result").first()).toBeVisible();
  });

  test("Close: clicking outside (backdrop) closes the popup", async ({ page }) => {
    await page.goto("/search");
    const firstCard = page.getByTestId("card-result").first();
    await expect(firstCard).toBeVisible({ timeout: 30_000 });
    await firstCard.click();

    const popup = page.getByTestId("card-details-popup");
    await expect(popup).toBeVisible();

    // Click the scrim/backdrop outside the popup content.
    await page.getByTestId("card-details-backdrop").click({ position: { x: 5, y: 5 } });

    await expect(popup).toBeHidden();
    await expect(page).toHaveURL(/\/search(\?|$)/);
    await expect(page.getByTestId("card-result").first()).toBeVisible();
  });
});
