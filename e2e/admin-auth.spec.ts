import { test, expect } from "@playwright/test";

/**
 * Isolated admin-auth e2e (UNAUTHENTICATED context — the admin world is its own
 * surface, so NO storageState here).
 *
 * Covers the hardened /admin flow:
 *   (a) /admin with no session → the admin LOGIN form renders IN PLACE (NOT a
 *       redirect to /login).
 *   (b) wrong creds → generic error, still on the form (no panel).
 *   (c) correct env creds → the OTP step appears.
 *   (d) read the code via the dev/test-only /api/admin-auth/__test-otp seam and
 *       submit it → the panel renders.
 *   (e) click LOG OUT → back to the admin login form.
 *   (f) public /login never routes to /admin.
 *
 * REQUIREMENTS to run green:
 *   - the server must run with NODE_ENV !== "production" (so the OTP dev-log /
 *     __test-otp seam is enabled; in production that route is a hard 404).
 *   - ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_SESSION_SECRET set in the server env.
 *   - a reachable DATABASE_URL (the panel's RSC pages query Prisma).
 * The default Playwright harness boots a PRODUCTION standalone build, where the
 * __test-otp seam is disabled by design — run this spec against a dev server
 * (see verification.md) or wire a non-prod webServer for the `admin` project.
 */

// Read the admin creds from the server env — never hardcode the real admin
// password/email in a committed file. The spec is skipped if they are unset.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

test.describe("isolated admin auth", () => {
  test("full login → OTP → panel → logout, with negative paths", async ({ page, request }) => {
    test.skip(
      !ADMIN_EMAIL || !ADMIN_PASSWORD,
      "ADMIN_EMAIL / ADMIN_PASSWORD must be set in the server env to run this spec"
    );
    const adminEmail = ADMIN_EMAIL as string;
    const adminPassword = ADMIN_PASSWORD as string;
    // (a) unauthenticated /admin shows the login form in-place, not /login.
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByText("Secure Login")).toBeVisible();
    await expect(page.locator("#admin-email")).toBeVisible();

    // (b) wrong credentials → generic error, no panel.
    await page.locator("#admin-email").fill(adminEmail);
    await page.locator("#admin-password").fill("definitely-wrong");
    await page.locator("#admin-sign-in").click();
    await expect(page.getByText("Invalid credentials.")).toBeVisible();
    await expect(page.locator("#admin-email")).toBeVisible(); // still the form

    // (c) correct credentials → OTP step.
    await page.locator("#admin-email").fill(adminEmail);
    await page.locator("#admin-password").fill(adminPassword);
    await page.locator("#admin-sign-in").click();
    await expect(page.locator("#admin-otp")).toBeVisible();

    // (d) read the code from the dev/test-only seam (shares the browser's
    // cookies so the nonce is sent) and submit it → panel renders.
    const otpRes = await request.get("/api/admin-auth/__test-otp");
    expect(otpRes.ok()).toBeTruthy();
    const { code } = (await otpRes.json()) as { code: string };
    expect(code).toMatch(/^\d{6}$/);
    await page.locator("#admin-otp").fill(code);
    await page.locator("#admin-verify-otp").click();

    // Panel renders — the sidebar brand + an admin nav item appear.
    await expect(page.getByText("Admin Panel").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
    // (f-local) the panel has NO "Back to App" link and HAS a Log Out control.
    await expect(page.getByText("Back to App")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Log Out" })).toBeVisible();

    // (e) log out → back to the admin login form.
    await page.getByRole("button", { name: "Log Out" }).click();
    await expect(page.locator("#admin-email")).toBeVisible();
  });

  test("public /login does not route a normal user into /admin", async ({ page }) => {
    // Without admin creds, /login is the ordinary user screen and never links
    // to or redirects into /admin.
    await page.goto("/login");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText("welcome to the dojo")).toBeVisible();
    // No admin affordance on the public login screen.
    await expect(page.getByText("Secure Login")).toHaveCount(0);
  });
});
