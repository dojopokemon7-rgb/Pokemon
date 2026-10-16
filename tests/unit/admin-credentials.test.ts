import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { constantTimeEqual, verifyAdminCredentials } from "@/lib/utils/admin-credentials";

/**
 * Admin credential compare — constant-time, env-defined superuser.
 *
 * Behavioural assertions only (we don't inspect timing internals): correct
 * creds pass, any wrong half fails, unset env fails closed, email is matched
 * case-insensitively.
 */

// Throwaway dummy test creds — the real admin credentials live only in .env
// (gitignored). The suite sets its own process.env below, so any values work.
const EMAIL = "test-admin@example.com";
const PASSWORD = "Test-Admin-Password-123";

describe("constantTimeEqual", () => {
  it("returns true for identical strings and false for different ones", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    // Different lengths still compare safely (hashed to equal-length buffers).
    expect(constantTimeEqual("short", "a much longer value")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("verifyAdminCredentials", () => {
  beforeEach(() => {
    process.env.ADMIN_EMAIL = EMAIL;
    process.env.ADMIN_PASSWORD = PASSWORD;
  });
  afterEach(() => {
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;
  });

  it("accepts the exact env email + password", () => {
    expect(verifyAdminCredentials(EMAIL, PASSWORD)).toBe(true);
  });

  it("rejects a wrong password", () => {
    expect(verifyAdminCredentials(EMAIL, "wrong-password")).toBe(false);
  });

  it("rejects a wrong email", () => {
    expect(verifyAdminCredentials("someoneelse@example.com", PASSWORD)).toBe(false);
  });

  it("matches the email case-insensitively (password stays exact)", () => {
    expect(verifyAdminCredentials("TEST-Admin@EXAMPLE.com", PASSWORD)).toBe(true);
    // Password remains case-sensitive.
    expect(verifyAdminCredentials(EMAIL, PASSWORD.toLowerCase())).toBe(false);
  });

  it("fails closed when the env creds are unset", () => {
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;
    expect(verifyAdminCredentials(EMAIL, PASSWORD)).toBe(false);
  });
});
