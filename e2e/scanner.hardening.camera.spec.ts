import { test, expect } from "@playwright/test";

/**
 * F-14 — Card Scanner hardening (edge cases).
 *
 * Runs under the `camera` project (fake media stream + storageState auth).
 * Each test forces one failure mode and asserts a graceful, non-crashing UI.
 * OCR is mocked via window.__mockOcrText so tesseract.js never runs here.
 */

test.describe("scanner hardening", () => {
  test("camera permission denied shows an error and an enable-camera action", async ({ page }) => {
    // Force getUserMedia to reject (as a real permission denial would),
    // overriding the fake-device grant before any app code runs.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: () =>
            Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
          enumerateDevices: () => Promise.resolve([]),
        },
      });
    });

    await page.goto("/scanner");

    await expect(page.getByText(/camera access denied/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /enable camera/i })).toBeVisible();
  });

  test("no confident match shows a not-recognized state with a manual search fallback", async ({ page }) => {
    // Recognizer OCR'd the image (vision) but nothing scored above threshold
    // → empty candidates. ocrSource is a real source (not "unavailable"), so
    // the client trusts this result rather than falling back to tesseract.
    await page.route("**/api/cards/recognize", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, ocrSource: "vision", feedbackId: "scan-e2e-2", candidates: [] }),
      })
    );

    await page.goto("/scanner");
    await expect(page.locator('[data-testid="camera-preview"], video').first()).toBeVisible();
    await page.getByRole("button", { name: /^scan$/i }).click();

    await expect(page.getByText(/card not recognized/i)).toBeVisible();
    // Manual fallback: a search box the user can pick the card with.
    await expect(page.getByRole("searchbox", { name: /search for a card/i })).toBeVisible();
    // And a way to retry the scan.
    await expect(page.getByRole("button", { name: /rescan/i })).toBeVisible();
  });

  test("recognition API 500 shows a generic error with retry and does not crash", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __mockOcrText?: string }).__mockOcrText = "CHARIZARD";
    });
    await page.route("**/api/cards/recognize", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ success: false, error: "Internal Server Error" }),
      })
    );

    await page.goto("/scanner");
    await expect(page.locator('[data-testid="camera-preview"], video').first()).toBeVisible();
    await page.getByRole("button", { name: /^scan$/i }).click();

    await expect(page.getByText(/scanner error, please try again/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /^scan$/i })).toBeVisible();
  });
});
