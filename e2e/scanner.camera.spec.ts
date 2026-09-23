import { test, expect } from "@playwright/test";

/**
 * F-14 — Card Scanner (OCR recognition flow).
 *
 * Flow: rear-camera preview → tap Scan → client OCR (mocked here via
 * window.__mockOcrText) → POST /api/cards/recognize (mocked to return
 * candidates) → "Is this your card?" confirmation list of the top matches
 * → tap a candidate's "Add to Collection".
 *
 * Runs under the `camera` project (fake media stream). OCR + the recognize
 * API are both mocked so the test is deterministic and never loads the
 * heavy tesseract.js WASM engine.
 */
test("scanner recognizes a card via OCR and offers to add a candidate", async ({ page }) => {
  // Inject the OCR result the "camera" would have read.
  await page.addInitScript(() => {
    (window as unknown as { __mockOcrText?: string }).__mockOcrText =
      "CHARIZARD 150 HP STAGE 2";
  });

  // Mock the recognition matcher to return real-shaped top-3 candidates.
  await page.route("**/api/cards/recognize", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        candidates: [
          { id: "base1-4", name: "Charizard", set: "Base Set", imageUrl: "", confidence: 0.92 },
          { id: "swsh4-25", name: "Charizard V", set: "Vivid Voltage", imageUrl: "", confidence: 0.61 },
          { id: "xy12-11", name: "Charizard EX", set: "Evolutions", imageUrl: "", confidence: 0.55 },
        ],
      }),
    })
  );

  await page.goto("/scanner");

  const preview = page.locator('[data-testid="camera-preview"], video');
  await expect(preview.first()).toBeVisible();

  await page.getByRole("button", { name: /^scan$/i }).click();

  // Confirmation screen lists the matched candidate…
  await expect(page.getByText(/is this your card/i)).toBeVisible();
  await expect(page.getByText(/charizard/i).first()).toBeVisible();

  // …and offers to add it to the collection.
  await expect(
    page.getByRole("button", { name: /add to collection/i }).first()
  ).toBeVisible();
});
