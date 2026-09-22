import { test, expect } from "@playwright/test";

/**
 * F-20 — Slow Add-to-Favourites (Optimistic UI). RED phase.
 *
 * Runs under the `authed` project (real server-trusted session via
 * storageState) against the real backend + Supabase (Prisma / Better Auth).
 *
 * Target behaviour (the end state these tests pin, NOT yet built):
 *   Clicking "Add to Favourites" flips the UI INSTANTLY (optimistic), before
 *   the network round-trip resolves. If the request then FAILS, the UI rolls
 *   back to its previous (un-favourited) state on its own.
 *
 * We drive this from the Card Details Popup on /search, whose favourite
 * button exposes `aria-pressed` bound to the favourite state — the cleanest
 * optimistic-state signal. The favourites GET is stubbed to empty so the
 * button reliably starts un-pressed regardless of the shared account's real
 * favourites; only the POST/DELETE mutation behaviour is under test.
 *
 * EXPECTED TO FAIL today: useFavorites only reflects the server query, which
 * updates after the POST resolves + a refetch (onSuccess → invalidate). So
 * the star does NOT flip until the network completes, and there is no
 * onError rollback at all.
 */

const FAVORITES_API = "**/api/users/me/favorites";

/** Open the first card's details popup on /search. */
async function openFirstCardPopup(page: import("@playwright/test").Page) {
  await page.goto("/search");
  const firstCard = page.getByTestId("card-result").first();
  await expect(firstCard).toBeVisible({ timeout: 30_000 });
  await firstCard.click();
  const popup = page.getByTestId("card-details-popup");
  await expect(popup).toBeVisible();
  return popup;
}

test.describe("F-20 Optimistic Favourites", () => {
  // Start every scenario with a known-empty favourites list so the button
  // begins un-pressed. (Stub only the GET; POST/DELETE are per-test.)
  test.beforeEach(async ({ page }) => {
    await page.route(FAVORITES_API, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ favorites: [] }),
        });
      } else {
        await route.fallback();
      }
    });
  });

  test("flips the star instantly, before the slow network resolves", async ({ page }) => {
    // Make the add (POST) take 2s to respond.
    await page.route(FAVORITES_API, async (route) => {
      if (route.request().method() === "POST") {
        await new Promise((r) => setTimeout(r, 2000));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.fallback();
      }
    });

    const popup = await openFirstCardPopup(page);
    const favBtn = popup.getByRole("button", { name: /add to (favourites|favorites)/i });
    await expect(favBtn).toHaveAttribute("aria-pressed", "false");

    await favBtn.click();

    // The star must reflect "favourited" WELL before the 2s network delay
    // finishes — proving the update is optimistic, not awaiting the POST.
    const pressed = popup.getByRole("button", { name: /remove from (favourites|favorites)/i });
    await expect(pressed).toHaveAttribute("aria-pressed", "true", { timeout: 1000 });
  });

  test("rolls back to un-favourited when the request fails (500)", async ({ page }) => {
    // Make the add (POST) fail with a 500, after a short beat so the
    // optimistic state is observably present before the rollback (a real
    // network round-trip always has some latency).
    await page.route(FAVORITES_API, async (route) => {
      if (route.request().method() === "POST") {
        await new Promise((r) => setTimeout(r, 1000));
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Internal Server Error" }),
        });
      } else {
        await route.fallback();
      }
    });

    const popup = await openFirstCardPopup(page);
    const favBtn = popup.getByRole("button", { name: /add to (favourites|favorites)/i });
    await expect(favBtn).toHaveAttribute("aria-pressed", "false");

    await favBtn.click();

    // Optimistically flips to pressed…
    await expect(
      popup.getByRole("button", { name: /remove from (favourites|favorites)/i })
    ).toHaveAttribute("aria-pressed", "true", { timeout: 1000 });

    // …then rolls back to un-favourited once the 500 comes back.
    await expect(
      popup.getByRole("button", { name: /add to (favourites|favorites)/i })
    ).toHaveAttribute("aria-pressed", "false", { timeout: 5000 });
  });
});
