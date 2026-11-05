import { afterEach, describe, expect, it } from "vitest";
import {
  resolveAuthEvents,
  setAuthIntent,
  takeAuthIntent,
} from "@/lib/analytics/auth-intent";

/**
 * Item 7 regression: signup_completed must fire ONCE. The guard is
 * takeAuthIntent being single-use (read + remove), so a second consume returns
 * null and the completion event cannot double-fire across the redirects that
 * separate the click from the authenticated session.
 */
describe("auth-intent duplicate-guard (item 7)", () => {
  afterEach(() => {
    window.sessionStorage.clear();
  });

  it("takeAuthIntent returns the stored intent ONCE then null (single-use)", () => {
    setAuthIntent("signup", "email");

    const first = takeAuthIntent();
    expect(first).not.toBeNull();
    expect(first?.kind).toBe("signup");
    expect(first?.method).toBe("email");

    // Second consume: already removed -> null. signup_completed cannot re-fire.
    expect(takeAuthIntent()).toBeNull();
  });

  it("ignores an expired intent (older than 30 minutes)", () => {
    setAuthIntent("login", "email");
    const future = Date.now() + 31 * 60 * 1000;
    expect(takeAuthIntent(future)).toBeNull();
  });

  it("resolveAuthEvents maps all four kinds correctly", () => {
    const now = Date.now();

    expect(resolveAuthEvents({ kind: "signup" }, null, now)).toEqual([
      "signup_completed",
    ]);

    expect(resolveAuthEvents({ kind: "login" }, null, now)).toEqual([
      "login_completed",
    ]);

    // oauth + recently created account (< 10 min) => fresh signup
    const recent = new Date(now - 60 * 1000);
    expect(resolveAuthEvents({ kind: "oauth" }, recent, now)).toEqual([
      "signup_started",
      "signup_completed",
    ]);

    // oauth + older account => returning login
    const old = new Date(now - 60 * 60 * 1000);
    expect(resolveAuthEvents({ kind: "oauth" }, old, now)).toEqual([
      "login_completed",
    ]);
  });
});
