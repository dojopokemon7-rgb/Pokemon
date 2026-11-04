import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetUsdInrCache,
  sanitizeProps,
  track,
  withMoney,
} from "@/lib/analytics/track";
import { resolveAuthEvents } from "@/lib/analytics/auth-intent";

const flush = () => new Promise((r) => setTimeout(r, 0));

function mockRate(rate: number | null, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    json: async () => ({ rate, asOf: rate ? "2026-11-04T00:00:00.000Z" : null }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("track()", () => {
  const capture = vi.fn();

  beforeEach(() => {
    capture.mockReset();
    resetUsdInrCache();
    delete window.posthog;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a safe no-op when PostHog is not initialized (no fetch, no throw)", () => {
    const f = mockRate(83);
    expect(() => track("card_added", { value_usd: 10 })).not.toThrow();
    expect(f).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("never throws when capture itself throws", async () => {
    window.posthog = {
      capture: () => {
        throw new Error("boom");
      },
    };
    expect(() => track("search_performed", { query_length: 3 })).not.toThrow();
    mockRate(83);
    expect(() => track("card_added", { value_usd: 5 })).not.toThrow();
    await flush();
  });

  it("strips sensitive keys but keeps safe ones", () => {
    window.posthog = { capture };
    track("login_completed", {
      method: "email",
      email: "a@b.com",
      password: "x",
      otp: "123456",
      access_token: "t",
      user_email: "a@b.com",
      footprint: 1,
    });
    expect(capture).toHaveBeenCalledWith("login_completed", {
      method: "email",
      footprint: 1,
    });
  });

  it("drops undefined and non-finite values", () => {
    expect(sanitizeProps({ a: 1, b: undefined, c: NaN, d: null })).toEqual({ a: 1, d: null });
  });

  it("attaches value_inr + currency USD when a real rate exists", async () => {
    mockRate(83.5);
    window.posthog = { capture };
    track("card_added", { value_usd: 10, game: "pokemon" });
    await flush();
    expect(capture).toHaveBeenCalledWith("card_added", {
      value_usd: 10,
      game: "pokemon",
      currency: "USD",
      value_inr: 835,
    });
  });

  it("OMITS value_inr entirely (never 0) when the rate is null, keeps value_usd", async () => {
    mockRate(null);
    window.posthog = { capture };
    track("card_added", { value_usd: 10 });
    await flush();
    const props = capture.mock.calls[0][1];
    expect(props).toEqual({ value_usd: 10, currency: "USD" });
    expect("value_inr" in props).toBe(false);
  });

  it("omits value_inr when the fx route fails", async () => {
    mockRate(83, false);
    window.posthog = { capture };
    track("card_removed", { value_usd: 2 });
    await flush();
    expect(capture.mock.calls[0][1]).toEqual({ value_usd: 2, currency: "USD" });
  });

  it("fetches the rate only once per session", async () => {
    const f = mockRate(80);
    window.posthog = { capture };
    track("card_added", { value_usd: 1 });
    track("card_added", { value_usd: 2 });
    await flush();
    track("card_removed", { value_usd: 3 });
    await flush();
    expect(f).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(3);
  });

  it("does not touch money logic for events without value_usd", () => {
    const f = mockRate(80);
    window.posthog = { capture };
    track("filter_applied", { filter_type: "set" });
    expect(f).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith("filter_applied", { filter_type: "set" });
  });
});

describe("withMoney()", () => {
  it("leaves non-money props alone", () => {
    expect(withMoney({ a: 1 }, 83)).toEqual({ a: 1 });
  });
  it("rounds INR to 2dp", () => {
    expect(withMoney({ value_usd: 1.234 }, 83.1).value_inr).toBe(102.55);
  });
});

describe("resolveAuthEvents()", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  it("maps explicit kinds", () => {
    expect(resolveAuthEvents({ kind: "signup" }, undefined, now)).toEqual(["signup_completed"]);
    expect(resolveAuthEvents({ kind: "login" }, undefined, now)).toEqual(["login_completed"]);
  });
  it("treats a fresh OAuth user as a signup and an old one as a login", () => {
    expect(resolveAuthEvents({ kind: "oauth" }, new Date(now - 60_000), now)).toEqual([
      "signup_started",
      "signup_completed",
    ]);
    expect(resolveAuthEvents({ kind: "oauth" }, new Date(now - 86_400_000), now)).toEqual([
      "login_completed",
    ]);
    expect(resolveAuthEvents({ kind: "oauth" }, undefined, now)).toEqual(["login_completed"]);
  });
});
