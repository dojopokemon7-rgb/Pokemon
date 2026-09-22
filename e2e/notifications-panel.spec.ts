import { test, expect } from "@playwright/test";

/**
 * Notifications Panel. RED phase.
 *
 * Runs under the `authed` project (real server-trusted session via
 * storageState) against the real backend + Supabase (Prisma / Better Auth).
 *
 * Target behaviour (the end state these tests pin, NOT yet built):
 *   The header bell icon toggles a dropdown notifications panel. It closes
 *   on an outside click or a second bell click. With no notifications it
 *   shows a clear "No new notifications" empty state.
 *
 * Selector contract for the GREEN phase:
 *   - The bell is the existing header button named /notifications/i.
 *   - The panel exposes data-testid="notifications-panel" (and/or
 *     role="dialog").
 *   - The empty state renders text matching /no new notifications/i.
 *
 * EXPECTED TO FAIL today: the header bell button has NO onClick and there
 * is no panel/dropdown anywhere — clicking it does nothing.
 */

const bell = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: /notifications/i });

const panel = (page: import("@playwright/test").Page) =>
  page.getByTestId("notifications-panel").or(page.getByRole("dialog"));

test.describe("Notifications Panel", () => {
  test("clicking the bell opens the panel; clicking the bell again closes it", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(bell(page)).toBeVisible({ timeout: 30_000 });

    // Opens on first click.
    await bell(page).click();
    await expect(panel(page)).toBeVisible();

    // Closes on a second bell click.
    await bell(page).click();
    await expect(panel(page)).toBeHidden();
  });

  test("clicking outside the panel closes it", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(bell(page)).toBeVisible({ timeout: 30_000 });

    await bell(page).click();
    await expect(panel(page)).toBeVisible();

    // Click far away from the panel (top-left corner of the page body).
    await page.mouse.click(5, 300);
    await expect(panel(page)).toBeHidden();
  });

  test("shows a 'No new notifications' empty state when there are none", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(bell(page)).toBeVisible({ timeout: 30_000 });

    await bell(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByText(/no new notifications/i)).toBeVisible();
  });
});
