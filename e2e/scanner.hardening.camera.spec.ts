import { test, expect } from "@playwright/test";

/**
 * F-14 — Card Scanner hardening (edge cases).
 *
 * Runs under the `camera` project (fake media stream + storageState auth).
 * Each test forces one failure mode and asserts a graceful, non-crashing UI.
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
        },
      });
    });

    await page.goto("/scanner");

    await expect(page.getByText(/camera access denied/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /enable camera/i })).toBeVisible();
  });

  test("unrecognizable image shows a not-recognized state and lets the user retry", async ({ page }) => {
    await page.route("**/api/cards/recognize", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: false, message: "Card not recognized" }),
      })
    );

    await page.goto("/scanner");
    await expect(page.locator('[data-testid="camera-preview"], video').first()).toBeVisible();
    await page.getByRole("button", { name: /^scan$/i }).click();

    await expect(page.getByText(/card not recognized/i)).toBeVisible();
    // Can try again: a Scan button is still available.
    await expect(page.getByRole("button", { name: /scan/i }).first()).toBeVisible();
  });

  test("recognition API 500 shows a generic error with retry and does not crash", async ({ page }) => {
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
    await expect(page.getByRole("button", { name: /scan/i }).first()).toBeVisible();
  });
});
