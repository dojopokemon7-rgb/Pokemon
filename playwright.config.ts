import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE } from "./e2e/constants";

/**
 * Playwright E2E config.
 *
 * `webServer` boots the app with `npm run dev` and waits for it before
 * running specs, so `npm run test:e2e` is self-contained. It reuses an
 * already-running dev server locally, and starts a fresh one in CI.
 *
 * NOTE: the app needs a reachable DATABASE_URL / env to fully render.
 * The home-page spec only asserts the /login redirect, which is served
 * by middleware + a server redirect and does not require the DB — so
 * the harness proves out even before a local DB is wired up.
 */
/**
 * Serve E2E on port 3001 to match BETTER_AUTH_URL in .env
 * (http://localhost:3001). The app's dev default is 3000, but Better Auth
 * scopes its session cookie and validates request Origin against that
 * configured base URL — so a login on :3000 sets a cookie the browser
 * won't send back, and the scanner's auth gate bounces to /login. Booting
 * the app on the auth base URL's port keeps cookies + origins consistent,
 * without editing the shared .env. (Fix the .env port to align dev + auth
 * as a separate cleanup.)
 */
const E2E_PORT = 3001;
const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // One retry locally (2 in CI) as a standard safety net for a shared
  // server / remote DB — the goal is first-try green. Full parallelism is
  // restored now that the suite runs against a precompiled production build
  // (no on-demand compilation) with airtight OAuth mocks (no state race).
  retries: process.env.CI ? 2 : 1,
  // Assertions wait up to 10s (default is 5s). The specs share ONE dev
  // server backed by a REMOTE Supabase DB, so under parallel load a
  // round-trip (e.g. the scanner's /api/cards/recognize + re-render) can
  // occasionally exceed 5s — a contention timeout, not an app bug. A fast
  // assertion still resolves instantly; this only extends the ceiling.
  // (Kept parallel on purpose: serial `workers:1` execution let Better
  // Auth's server-side OAuth state leak between the Google specs.)
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: E2E_BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      // Provisions a logged-in session and saves it to storageState.
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      // The home spec asserts the unauthenticated / → /login redirect, so
      // it must NOT carry a session. No storageState here on purpose.
      // Google + authed specs run in their own projects below.
      testIgnore: [/.*\.camera\.spec\.ts/, /google-login\.spec\.ts/, /(collections-ui|want-list|visual-regression|card-details-popup|chart-interactivity|show-more-duplicates|graded-add-flow|optimistic-favorites|search-debounce|folder-filters|notifications-panel)\.spec\.ts/],
    },
    {
      // Google login specs need a server-trusted session so the
      // (dashboard) layout's getServerSession() gate passes — the Google
      // OAuth bits themselves are mocked at the network layer inside the
      // specs. Reuses the same storageState the scanner camera project does.
      name: "google",
      testMatch: /google-login\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: STORAGE_STATE,
      },
    },
    {
      // General authenticated specs (logged-in via storageState) that don't
      // need camera flags — e.g. collections management on /you.
      name: "authed",
      testMatch: /(collections-ui|want-list|visual-regression|card-details-popup|chart-interactivity|show-more-duplicates|graded-add-flow|optimistic-favorites|search-debounce|folder-filters|notifications-panel)\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: STORAGE_STATE,
      },
    },
    {
      // Dedicated project for camera-dependent specs (the scanner). Chromium
      // is launched with a fake media device so getUserMedia() resolves to a
      // synthetic video stream and no real hardware / permission prompt is
      // needed. `permissions: ["camera"]` pre-grants the getUserMedia grant.
      // The scanner is auth-gated, so this project reuses the session from
      // the `setup` project via storageState.
      name: "camera",
      testMatch: /.*\.camera\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: STORAGE_STATE,
        permissions: ["camera"],
        launchOptions: {
          args: [
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
          ],
        },
      },
    },
  ],
  // Test against a PRODUCTION build, not `next dev`. Precompiled routes
  // serve instantly, eliminating the on-demand-compilation timeouts that
  // made the suite flaky under parallel load on a shared server. Still on
  // port 3001 to match BETTER_AUTH_URL in .env (see note above). The build
  // step makes startup take longer, hence the higher timeout.
  // Build, then run the STANDALONE server output (matches Docker prod and
  // silences the "next start doesn't work with output: standalone" warning).
  // The standalone server reads PORT from env rather than a --port flag.
  webServer: {
    command: `npm run build:standalone && node .next/standalone/server.js`,
    url: E2E_BASE_URL,
    // Pin the auth base URL to the E2E port so the suite is independent of
    // whatever BETTER_AUTH_URL is set to in .env for local dev (which may be
    // :3000 for real Google OAuth). Better Auth scopes its session cookie and
    // validates request Origin against this, and auth.setup.ts signs in with a
    // matching :3001 origin — so cookies + origin always line up here.
    env: {
      PORT: String(E2E_PORT),
      BETTER_AUTH_URL: E2E_BASE_URL,
      NEXT_PUBLIC_APP_URL: E2E_BASE_URL,
    },
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
});
