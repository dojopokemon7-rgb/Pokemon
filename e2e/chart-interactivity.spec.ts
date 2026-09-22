import { test, expect } from "@playwright/test";

/**
 * F-09 — Chart Interactivity (price-history tooltip). RED phase.
 *
 * Runs under the `authed` project (real server-trusted session via
 * storageState) against the real backend + Supabase.
 *
 * Target behaviour (the end state these tests pin, NOT yet built):
 * the "Price history" chart on the card detail page must show a TOOLTIP
 * when a data point is hovered (desktop) or tapped (mobile). The tooltip
 * displays that point's exact DATE and PRICE, and clicking away dismisses
 * it.
 *
 * We use a card with REAL seeded history so the tooltip has a genuine
 * date + price to show (Charizard base1-4 — one of the F-18 seeded cards).
 *
 * EXPECTED TO FAIL today: the DojoChart draws a hover guide line + marker
 * dots but renders NO tooltip element — there is no date/price readout and
 * no dismiss behaviour.
 *
 * Selector contract for the GREEN phase:
 *   - The chart wrapper carries role="img" aria-label="Price history chart".
 *   - The tooltip exposes data-testid="chart-tooltip".
 *   - The tooltip text contains a USD price (e.g. "$360.53") AND a date
 *     label (a month name like "Jun" or a "YYYY-MM-DD" / "MM/DD" form).
 */

// Detail URL for a card that has real seeded price history (F-18).
const CARD_URL = "/search/base1-4?name=Charizard&set=Base%20Set&game=pokemon";

// A tooltip must show BOTH a price and a date. Kept loose on the exact
// values (seeded prices carry ±noise) — the contract is "shows the point's
// date and price", not a specific number.
const PRICE_RE = /\$\s?\d/;
const DATE_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2})/i;

test.describe("F-09 Chart Interactivity", () => {
  test("Hover (desktop): a tooltip shows the point's date and price", async ({ page }) => {
    await page.goto(CARD_URL);

    const chart = page.getByRole("img", { name: /price history chart/i });
    await expect(chart).toBeVisible({ timeout: 30_000 });

    // Hover a data point (near the middle of the chart — the handler snaps
    // to the nearest sample).
    await chart.hover({ position: { x: 165, y: 85 } });

    const tooltip = page.getByTestId("chart-tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText(PRICE_RE);
    await expect(tooltip).toHaveText(DATE_RE);
  });

  // Mobile tap needs a touch-enabled context (touchscreen.tap requires
  // hasTouch) and a phone viewport.
  test.describe("mobile", () => {
    test.use({ viewport: { width: 360, height: 800 }, hasTouch: true });

    test("Tap (mobile): a tooltip shows the point's date and price", async ({ page }) => {
      await page.goto(CARD_URL);

      const chart = page.getByRole("img", { name: /price history chart/i });
      await expect(chart).toBeVisible({ timeout: 30_000 });

      // Tap the chart via the locator API: unlike page.touchscreen.tap
      // (raw viewport coords), locator.tap() scrolls the element into view
      // and taps its centre — the chart sits below the fold on a 360×800
      // phone, so a raw coordinate tap would miss it entirely.
      await chart.tap();

      const tooltip = page.getByTestId("chart-tooltip");
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toHaveText(PRICE_RE);
      await expect(tooltip).toHaveText(DATE_RE);
    });
  });

  test("Dismiss: clicking outside the chart hides the tooltip", async ({ page }) => {
    await page.goto(CARD_URL);

    const chart = page.getByRole("img", { name: /price history chart/i });
    await expect(chart).toBeVisible({ timeout: 30_000 });

    await chart.hover({ position: { x: 165, y: 85 } });
    const tooltip = page.getByTestId("chart-tooltip");
    await expect(tooltip).toBeVisible();

    // Click well away from the chart (top-left of the page header area).
    await page.mouse.click(5, 5);

    await expect(tooltip).toBeHidden();
  });
});
