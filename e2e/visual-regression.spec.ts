import { test, expect } from "@playwright/test";

/**
 * F-01 — Responsiveness / visual regression baselines.
 *
 * Runs under the `authed` project (real session via storageState). Captures
 * full-page screenshots of the key pages at Mobile / Tablet / Desktop widths.
 *
 * NOTE: the first run only GENERATES baselines (all pass); the value is (a) a
 * regression guard for future runs and (b) the captured PNGs, which we
 * inspect to find current responsive flaws. Screenshots include dynamic
 * content (prices, mock deltas, chart) so as a strict CI gate these would
 * later need masking; for baseline capture that's fine. `animations:disabled`
 * + a small settle wait reduce jitter.
 */

// Visual-regression baselines capture live pages that include DYNAMIC
// content (prices, mock deltas, real card art, empty-vs-populated states).
// Pixel-diffing that against committed baselines is inherently noisy, so
// these are NOT part of the blocking `npm run verify` gate — they're an
// on-demand tool for capturing/inspecting layout. Run explicitly with
// `VISUAL=1 npx playwright test e2e/visual-regression.spec.ts [--update-snapshots]`.
// A deterministic CI gate would require masking the dynamic regions first.
const VISUAL_ENABLED = !!process.env.VISUAL;

const VIEWPORTS = [
  { name: "mobile", width: 360, height: 800 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 900 },
] as const;

for (const vp of (VISUAL_ENABLED ? VIEWPORTS : [])) {
  test.describe(`responsive @ ${vp.name} (${vp.width}px)`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("dashboard", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page.getByText(/portfolio value/i)).toBeVisible();
      await expect(page).toHaveScreenshot(`dashboard-${vp.name}.png`, { fullPage: true, animations: "disabled" });
    });

    test("search", async ({ page }) => {
      await page.goto("/search", { waitUntil: "networkidle" });
      // Capture whatever the page renders (tiles, empty state, or onboarding
      // gate) — the point is to document the actual responsive state, not to
      // gate on data that the shared/remote backend may not return.
      await expect(page.getByRole("searchbox", { name: /search cards/i })).toBeVisible();
      await expect(page).toHaveScreenshot(`search-${vp.name}.png`, { fullPage: true, animations: "disabled" });
    });

    test("card detail", async ({ page }) => {
      // Navigate to a detail page directly with query params (the shape the
      // search grid produces), so capture doesn't depend on trending tiles
      // being present to click.
      await page.goto("/search/base1-4?name=Charizard&set=Base%20Set", { waitUntil: "networkidle" });
      await expect(page).toHaveURL(/\/search\/.+/);
      await expect(page).toHaveScreenshot(`card-detail-${vp.name}.png`, { fullPage: true, animations: "disabled" });
    });

    test("want list", async ({ page }) => {
      await page.goto("/wantlist");
      await expect(page.getByRole("tab", { name: /want to buy/i })).toBeVisible();
      await expect(page).toHaveScreenshot(`want-list-${vp.name}.png`, { fullPage: true, animations: "disabled" });
    });
  });
}
