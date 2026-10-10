import { test, expect } from "@playwright/test";

/** FEAT-003 — Explore filters are visible by default and work without a text query. */
test.describe("Explore filters (default view)", () => {
  test("filters show with no query and choosing a language updates the URL", async ({ page }) => {
    await page.goto("/search");
    const language = page.getByTestId("language-filter");
    await expect(language).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("graded-filter")).toBeVisible();

    await language.selectOption("ja");
    await expect(page).toHaveURL(/[?&]language=ja/);
    await expect(page).not.toHaveURL(/[?&]q=/);

    // Clearing the last filter returns to the trending view.
    await language.selectOption("");
    await expect(page).not.toHaveURL(/[?&]language=/);
    await expect(page.getByText("Trending this week")).toBeVisible();
  });
});
