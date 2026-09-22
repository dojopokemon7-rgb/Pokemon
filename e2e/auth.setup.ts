import { test as setup, expect } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { STORAGE_STATE } from "./constants";

/**
 * Auth setup for camera/dashboard E2E specs.
 *
 * The scanner lives under the `(dashboard)` route group, whose layout
 * enforces server-side auth (no session → redirect to /login). So specs
 * that visit `/scanner` need a logged-in session BEFORE they run — without
 * touching the frozen spec files.
 *
 * This project-dependency creates (idempotently) a dedicated E2E user via
 * Better Auth's email sign-up endpoint and saves the resulting session
 * cookie to `storageState`, which the `camera` project then reuses. The
 * seeded users have no password credential (the seed only writes User rows,
 * not Account rows), so we provision a real credentialed user here instead.
 */
const E2E_EMAIL = "e2e-scanner@example.com";
const E2E_PASSWORD = "e2e-Password-123";
const E2E_NAME = "E2E Scanner User";

setup("authenticate", async ({ request }) => {
  // Better Auth's CSRF check requires an Origin header matching its trusted
  // base (BETTER_AUTH_URL = http://localhost:3001 in .env). The E2E dev
  // server is booted on 3001 to match, so cookies + origin line up.
  const headers = { origin: "http://localhost:3001" };

  // Sign up (idempotent): if the user already exists this 4xxs, which is
  // fine — we fall through to sign-in either way.
  await request.post("/api/auth/sign-up/email", {
    data: { email: E2E_EMAIL, password: E2E_PASSWORD, name: E2E_NAME },
    headers,
    failOnStatusCode: false,
  });

  // Sign in to set the session cookie ON THIS SAME request context.
  const signIn = await request.post("/api/auth/sign-in/email", {
    data: { email: E2E_EMAIL, password: E2E_PASSWORD },
    headers,
    failOnStatusCode: false,
  });
  expect(signIn.ok(), `sign-in failed: ${signIn.status()} ${await signIn.text()}`).toBeTruthy();

  // Save state from the SAME context that performed the sign-in. (Saving
  // from a different context — e.g. context.request — yields empty cookies.)
  const dir = dirname(STORAGE_STATE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const state = await request.storageState();
  expect(state.cookies.length, "no session cookie captured after sign-in").toBeGreaterThan(0);
  await request.storageState({ path: STORAGE_STATE });
});
