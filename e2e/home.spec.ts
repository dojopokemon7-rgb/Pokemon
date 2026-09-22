import { test, expect } from "@playwright/test";

/**
 * Smoke test: the harness works and the app boots.
 *
 * The root route (`/`) issues a server redirect to `/login` (see
 * src/app/page.tsx). Loading `/` should therefore land the browser on
 * the login screen. This exercises the full boot path (Next server +
 * middleware) without needing any seeded data.
 */
test("home page redirects to the login screen", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
});
