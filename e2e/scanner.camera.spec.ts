import { test, expect } from "@playwright/test";

/**
 * F-14 — Card Scanner (RED phase).
 *
 * Target behavior per the agreed contract:
 *   Camera preview → tap Scan → POST /api/cards/recognize →
 *   result displays the matched card ("Charizard") + an
 *   "Add to Collection" button.
 *
 * Runs under the Playwright `camera` project, which launches Chromium
 * with fake media-stream flags so getUserMedia() yields a synthetic
 * video feed (no real hardware / permission prompt).
 *
 * EXPECTED TO FAIL right now: /scanner is a static placeholder — there
 * is no <video> preview, no Scan control, no recognize API, and no
 * result UI. This test pins the end state before implementation.
 */
test("scanner recognizes a card and offers to add it", async ({ page }) => {
  await page.goto("/scanner");

  // 1) A live camera preview element should be present.
  const preview = page.locator('[data-testid="camera-preview"], video');
  await expect(preview.first()).toBeVisible();

  // 2) Trigger a scan.
  await page.getByRole("button", { name: /scan/i }).click();

  // 3) The recognition result should surface the matched card…
  await expect(page.getByText(/charizard/i)).toBeVisible();

  // …and offer to add it to the collection.
  await expect(
    page.getByRole("button", { name: /add to collection/i })
  ).toBeVisible();
});
