import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { signAdminSession, verifyAdminSession } from "@/lib/utils/admin-session";

/**
 * Admin session token — HMAC sign/verify, tamper + expiry + wrong-secret
 * rejection, fail-closed when no secret is set.
 */

const SECRET = "test-admin-session-secret-0123456789";

describe("admin-session sign/verify", () => {
  beforeEach(() => {
    process.env.ADMIN_SESSION_SECRET = SECRET;
    delete process.env.BETTER_AUTH_SECRET;
  });
  afterEach(() => {
    delete process.env.ADMIN_SESSION_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
  });

  it("round-trips a freshly signed token", () => {
    const token = signAdminSession();
    expect(verifyAdminSession(token)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const token = signAdminSession();
    const [payload, sig] = token.split(".");
    // Flip a character in the payload — the HMAC no longer matches.
    const flipped = (payload[0] === "A" ? "B" : "A") + payload.slice(1);
    expect(verifyAdminSession(`${flipped}.${sig}`)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const token = signAdminSession();
    const [payload, sig] = token.split(".");
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(verifyAdminSession(`${payload}.${flipped}`)).toBe(false);
  });

  it("rejects an expired token (ttl 0 → already past exp)", () => {
    // ttl of -1s → exp strictly before now → rejected even with a valid sig.
    const token = signAdminSession(-1);
    expect(verifyAdminSession(token)).toBe(false);
  });

  it("rejects a token signed with a different secret", () => {
    const token = signAdminSession();
    process.env.ADMIN_SESSION_SECRET = "a-totally-different-secret-value";
    expect(verifyAdminSession(token)).toBe(false);
  });

  it("rejects malformed / empty tokens", () => {
    expect(verifyAdminSession(undefined)).toBe(false);
    expect(verifyAdminSession("")).toBe(false);
    expect(verifyAdminSession("no-dot-here")).toBe(false);
    expect(verifyAdminSession(".onlysig")).toBe(false);
    expect(verifyAdminSession("onlypayload.")).toBe(false);
  });

  it("falls back to BETTER_AUTH_SECRET when ADMIN_SESSION_SECRET is unset", () => {
    delete process.env.ADMIN_SESSION_SECRET;
    process.env.BETTER_AUTH_SECRET = "better-auth-fallback-secret";
    const token = signAdminSession();
    expect(verifyAdminSession(token)).toBe(true);
  });

  it("fails closed (verify false) when NO secret is set", () => {
    delete process.env.ADMIN_SESSION_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    // signAdminSession would throw with no secret; verify must simply reject.
    expect(verifyAdminSession("someheader.somesig")).toBe(false);
  });
});
