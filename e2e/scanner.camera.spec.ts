import { test, expect } from "@playwright/test";

/**
 * F-14 — Card Scanner (multi-signal recognition flow).
 *
 * Flow: rear-camera preview with a card-shaped framing outline → tap Scan →
 * the captured image is POSTed to /api/cards/recognize (mocked here), which
 * would OCR it with Google Cloud Vision server-side and run the multi-signal
 * matching engine → "Tap your card to add it" confirmation list of the TOP 5
 * matches (image + name + set + confidence) → tap a candidate to add it.
 *
 * Runs under the `camera` project (fake media stream). The recognize API is
 * mocked so the test is deterministic and never calls Vision or loads the
 * tesseract.js fallback engine. window.__mockOcrText is a no-op here since the
 * mocked image path succeeds without falling back to on-device OCR.
 */
test("scanner recognizes a card and offers the top candidates to add", async ({ page }) => {
  // Mock the recognition endpoint to return real-shaped top candidates plus a
  // feedbackId (the client PATCHes it with the user's pick).
  await page.route("**/api/cards/recognize", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        ocrSource: "vision",
        feedbackId: "scan-e2e-1",
        candidates: [
          { id: "base1-4", name: "Charizard", set: "Base Set", imageUrl: "", confidence: 0.95 },
          { id: "swsh4-25", name: "Charizard V", set: "Vivid Voltage", imageUrl: "", confidence: 0.61 },
          { id: "xy12-11", name: "Charizard EX", set: "Evolutions", imageUrl: "", confidence: 0.55 },
        ],
      }),
    })
  );

  await page.goto("/scanner");

  const preview = page.locator('[data-testid="camera-preview"], video');
  await expect(preview.first()).toBeVisible();
  // The card-shaped framing outline guides the user before capture.
  await expect(page.getByTestId("card-outline")).toBeVisible();

  await page.getByRole("button", { name: /^scan$/i }).click();

  // Confirmation screen lists the matched candidate as a tappable row. The
  // confirm-phase marker is the "Tap your card to add it" heading, and each
  // candidate is an "Add <name> to your portfolio" button.
  await expect(page.getByText(/tap your card to add it/i)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /add charizard to your portfolio/i }).first()
  ).toBeVisible();
  // …with a percentage confidence shown.
  await expect(page.getByText(/%\s*match/i).first()).toBeVisible();
  // …and a manual-search escape hatch.
  await expect(
    page.getByRole("button", { name: /search manually/i })
  ).toBeVisible();
});

/**
 * FR-2d / AC-17 — Scrydex Vision is UNRESOLVED (FEAT-001 probe: all candidate
 * paths 404'd), so identifyCard() returns null and recognize/route.ts degrades
 * to on-device Tesseract. Here we mock the recognize endpoint to return the
 * Tesseract-fallback shape (ocrSource: "tesseract", server could not use
 * Vision) and assert the scan still produces candidates — the fallback path a
 * real scan takes today. Never a fabricated Vision match.
 */
test("scanner falls back to on-device Tesseract and still offers candidates", async ({ page }) => {
  await page.route("**/api/cards/recognize", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        // Vision unavailable → the route used the on-device OCR text path.
        ocrSource: "tesseract",
        feedbackId: "scan-e2e-fallback-1",
        candidates: [
          { id: "base1-4", name: "Charizard", set: "Base Set", imageUrl: "", confidence: 0.72 },
        ],
      }),
    })
  );

  await page.goto("/scanner");

  const preview = page.locator('[data-testid="camera-preview"], video');
  await expect(preview.first()).toBeVisible();
  await expect(page.getByTestId("card-outline")).toBeVisible();

  await page.getByRole("button", { name: /^scan$/i }).click();

  // Even on the Tesseract fallback path, the confirmation screen lists a
  // tappable candidate — the scanner is not blocked by Vision being
  // unresolved.
  await expect(page.getByText(/tap your card to add it/i)).toBeVisible();
  await expect(
    page.getByRole("button", { name: /add charizard to your portfolio/i }).first()
  ).toBeVisible();
});
