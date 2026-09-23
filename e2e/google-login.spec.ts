import { test, expect } from "@playwright/test";

/**
 * F-02 — Google Login (Better Auth social provider). RED phase.
 *
 * The app uses Better Auth + Supabase (NOT Firebase). Real Google
 * credentials can't run locally/CI, so we mock at the Better Auth
 * boundary: intercept the social sign-in initiation
 * (POST /api/auth/sign-in/social) and the provider callback
 * (GET /api/auth/callback/google) with page.route.
 *
 * EXPECTED TO FAIL today: the Google button is a stub that only shows a
 * "coming in Week 4" toast — it never calls authClient.signIn.social, the
 * server has no socialProviders.google configured, the "Connect" row on
 * /you is local-state only (never shows "Google Connected"), and there is
 * no cancellation error surface. These tests pin the target behavior.
 */

const GOOGLE_USER = {
  name: "Ash Ketchum",
  email: "ash.ketchum@gmail.com",
  image: "https://lh3.googleusercontent.com/a/ash-avatar",
};

const ORIGIN = "http://localhost:3001";

/**
 * Routes the Better Auth social endpoints so the OAuth dance completes
 * without leaving our origin. `success=true` simulates the user approving
 * Google and returning with a valid session; `success=false` simulates a
 * cancel/deny.
 */
async function mockGoogleOAuth(page: import("@playwright/test").Page, success: boolean) {
  // Register intercepts at the CONTEXT level (not page) so they apply to
  // every navigation/request in the context and are in place before any
  // page interaction — the real Better Auth OAuth code path can never run,
  // regardless of parallel-run concurrency.
  const context = page.context();

  // Mutable link state: flips to true once the account-link callback runs.
  let googleLinked = false;
  // 1) App asks Better Auth to start the social flow. Instead of a real
  //    redirect to accounts.google.com, point the browser back at our
  //    mocked callback.
  await context.route("**/api/auth/sign-in/social", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: `${ORIGIN}/api/auth/callback/google?mock=${success ? "ok" : "cancel"}` }),
    });
  });

  // 2) The provider callback. On success, redirect to the dashboard WITHOUT
  //    setting a session cookie — the real server-trusted session comes from
  //    the project's storageState (see the `google` project in
  //    playwright.config.ts). Overwriting it with a fake token here would
  //    make the real (dashboard) server gate reject the request. On cancel,
  //    bounce to /login with an error param the login page surfaces.
  await context.route("**/api/auth/callback/google**", async (route) => {
    const to = new URL(route.request().url()).searchParams.get("to");
    // A callback returning to /you is the account-link flow completing —
    // mark Google linked so the follow-up listAccounts() reports it.
    if (success && to === "/you") googleLinked = true;
    await route.fulfill({
      status: 302,
      headers: { location: success ? to ?? "/dashboard" : "/login?error=google_cancelled" },
      body: "",
    });
  });

  // Account linking initiation (authClient.linkSocial). We simulate the
  // link completing server-side immediately: flip the stateful link flag
  // and return WITHOUT a redirect URL, so the app refreshes its accounts
  // list in place (no OAuth round-trip, no real callback / state check).
  await context.route("**/api/auth/link-social", async (route) => {
    if (success) googleLinked = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: true }),
    });
  });

  // 3) Client-side session reads reflect the mocked Google user on success,
  //    so the dashboard shell shows the Google identity. (Server-side
  //    getServerSession still validates the real storageState session — this
  //    only affects the client useSession() render.)
  await context.route("**/api/auth/get-session", async (route) => {
    if (success) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ user: GOOGLE_USER, session: { token: "storage-state-session" } }),
      });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    }
  });

  // 4) Account-linking state — STATEFUL. Google starts UNLINKED so the
  //    /you page renders the "Connect Google" button; once the link flow
  //    runs the callback (to=/you), it flips to linked so a subsequent
  //    listAccounts() reports Google and the UI shows "Google Connected".
  await context.route("**/api/auth/list-accounts", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(googleLinked ? [{ provider: "google", providerId: "google", accountId: "mock-google" }] : []),
    });
  });

  // 5) Sign-out resolves immediately. Without this the better-auth client's
  //    post-signout session refresh can hang against the mocked get-session
  //    route, so `await authClient.signOut()` never resolves and the page's
  //    redirect-to-/login never fires.
  await context.route("**/api/auth/sign-out", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
  });

  // 6) SAFETY NET: if the real OAuth path is ever reached (e.g. a stray
  //    redirect the mocks above didn't shape), Better Auth would bounce to
  //    /api/auth/error?error=state_not_found. Intercept that and any real
  //    Google callback so a concurrency race can never surface the real
  //    error page — redirect to the expected destination instead.
  await context.route("**/api/auth/error**", async (route) => {
    await route.fulfill({
      status: 302,
      headers: { location: success ? "/dashboard" : "/login?error=google_cancelled" },
      body: "",
    });
  });
}

test.describe("F-02 Google login", () => {
  test("happy path: sign in with Google lands on dashboard with Google profile", async ({ page }) => {
    await mockGoogleOAuth(page, true);

    await page.goto("/login");
    await page.locator("#btn-google").click();

    // Should end up authenticated on the dashboard…
    await expect(page).toHaveURL(/\/dashboard/);
    // …and the Google identity should persist into the session. The header
    // no longer shows the username (per design), so verify identity on the
    // You page, which renders the session handle (@ash.ketchum from the
    // Google name "Ash Ketchum").
    await page.goto("/you");
    const handle = "@" + GOOGLE_USER.name.toLowerCase().replace(/\s+/g, ".");
    await expect(page.getByText(handle)).toBeVisible();
  });

  test("account linking: connecting Google shows 'Google Connected'", async ({ page }) => {
    await mockGoogleOAuth(page, true);

    // Precondition: a logged-in user. The `google` Playwright project loads
    // a real server-trusted session via storageState (auth.setup.ts), so we
    // land on the dashboard directly — no redundant email/password sign-in
    // (which would double-authenticate and hang on the client refresh).
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard/);

    // Go to account settings and link Google.
    await page.goto("/you");
    await page.getByRole("button", { name: /connect google/i }).click();

    await expect(page.getByText(/google connected/i)).toBeVisible();
  });

  test("user cancels: stays on login with a clear error, no crash", async ({ page }) => {
    await mockGoogleOAuth(page, false);

    await page.goto("/login");
    await page.locator("#btn-google").click();

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(/google login cancelled/i)).toBeVisible();
  });

  test("logout: after Google login, logging out clears session and returns to login", async ({ page }) => {
    await mockGoogleOAuth(page, true);

    await page.goto("/login");
    await page.locator("#btn-google").click();
    await expect(page).toHaveURL(/\/dashboard/);

    // Log out from the account page.
    await page.goto("/you");
    await page.locator("#btn-account-logout").click();

    await expect(page).toHaveURL(/\/login/);
  });
});
