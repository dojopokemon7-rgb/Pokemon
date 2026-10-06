import { describe, it, expect } from "vitest";
import { isSignupAllowed } from "@/lib/utils/signup-allowlist";

/**
 * Guards the env-driven signup gate. The allowlist is comma-separated exact
 * emails and/or `@domain` suffixes; empty/unset means signup is OPEN so dev,
 * CI, and the existing suites keep working without configuration.
 */
describe("isSignupAllowed", () => {
  it("opens signup when the allowlist is unset", () => {
    expect(isSignupAllowed("anyone@example.com", undefined)).toBe(true);
  });

  it("opens signup when the allowlist is empty or whitespace", () => {
    expect(isSignupAllowed("anyone@example.com", "")).toBe(true);
    expect(isSignupAllowed("anyone@example.com", "  , ")).toBe(true);
  });

  it("allows an exact email match", () => {
    expect(isSignupAllowed("me@x.com", "me@x.com,other@y.com")).toBe(true);
  });

  it("allows any address on an allowed @domain", () => {
    expect(isSignupAllowed("anyone@trusted.org", "@trusted.org")).toBe(true);
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    expect(isSignupAllowed("  ME@X.com ", " me@x.com ")).toBe(true);
    expect(isSignupAllowed("User@Trusted.ORG", "@trusted.org")).toBe(true);
  });

  it("rejects an email that is not on the list", () => {
    expect(isSignupAllowed("nope@evil.com", "me@x.com,@trusted.org")).toBe(false);
  });

  it("does not treat an exact-email entry as a domain match", () => {
    expect(isSignupAllowed("other@x.com", "me@x.com")).toBe(false);
  });
});
