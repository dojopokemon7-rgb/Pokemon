import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";

/**
 * F-02 (email-OTP, Phase A) — real signup → verify → /profile flow.
 *
 * Runs on the chromium project (unauthenticated, origin http://localhost:3001)
 * against the standalone PRODUCTION build. Proves the production-shaped flow end
 * to end WITHOUT dev-log (unavailable on the prod build) and WITHOUT mutating
 * the code: it reads the issued OTP from the real `Verification` table via the
 * read-otp fixture and submits it through the real verifyEmail endpoint.
 *
 * The logged-in landing on /profile is only reachable because
 * `emailVerification.autoSignInAfterVerification: true` is set in auth.ts.
 */
test("signup → verify email with OTP → lands on /profile", async ({ page, request }) => {
  const email = `e2e-otp-${Date.now()}@example.com`;
  const password = "e2e-Password-123";

  // Sign up via the API (origin must match BETTER_AUTH_URL for the CSRF check).
  const signUp = await request.post("/api/auth/sign-up/email", {
    data: { email, password, name: "E2E OTP User" },
    headers: { origin: "http://localhost:3001" },
    failOnStatusCode: false,
  });
  expect(signUp.ok(), `sign-up failed: ${signUp.status()} ${await signUp.text()}`).toBeTruthy();

  // Read the pending OTP straight from the Verification table (plain storage).
  const otp = execSync(`npx tsx e2e/fixtures/read-otp.ts ${email}`, {
    encoding: "utf8",
  }).trim();
  expect(otp).toMatch(/^\d{6}$/);

  // Enter it on the verify screen (as the signup redirect would land the user).
  await page.goto(`/verify-otp?email=${encodeURIComponent(email)}`);
  await page.locator("#verify-code").fill(otp);
  await page.locator("#btn-verify").click();

  // Verified + auto-signed-in → onboarding at /profile.
  await expect(page).toHaveURL(/\/profile/);
});
