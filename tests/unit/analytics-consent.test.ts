/**
 * Unit tests for the pure analytics consent/env-gating helper.
 * No window, no localStorage, no network — the helper is pure (RULE 11).
 */
import { describe, it, expect } from "vitest";
import {
  shouldInit,
  parseConsent,
  CONSENT_STORAGE_KEY,
} from "@/lib/utils/analytics-consent";

describe("shouldInit", () => {
  it("inits when consent granted AND key present", () => {
    expect(shouldInit("granted", "phc_abc")).toBe(true);
  });

  it("does NOT init on an empty key", () => {
    expect(shouldInit("granted", "")).toBe(false);
  });

  it("does NOT init on a whitespace-only key", () => {
    expect(shouldInit("granted", "   ")).toBe(false);
  });

  it("does NOT init when the key is undefined", () => {
    expect(shouldInit("granted", undefined)).toBe(false);
  });

  it("does NOT init when the key is null", () => {
    expect(shouldInit("granted", null)).toBe(false);
  });

  it("does NOT init when consent is denied", () => {
    expect(shouldInit("denied", "phc_abc")).toBe(false);
  });

  it("does NOT init when no choice has been made (null)", () => {
    expect(shouldInit(null, "phc_abc")).toBe(false);
  });

  it("does NOT init when consent is undefined", () => {
    expect(shouldInit(undefined, "phc_abc")).toBe(false);
  });
});

describe("parseConsent", () => {
  it("passes through granted", () => {
    expect(parseConsent("granted")).toBe("granted");
  });

  it("passes through denied", () => {
    expect(parseConsent("denied")).toBe("denied");
  });

  it("returns null for null (SSR / unset)", () => {
    expect(parseConsent(null)).toBe(null);
  });

  it("returns null for an empty string", () => {
    expect(parseConsent("")).toBe(null);
  });

  it("returns null for a corrupt value", () => {
    expect(parseConsent("garbage")).toBe(null);
  });
});

describe("CONSENT_STORAGE_KEY", () => {
  it("is the documented localStorage key", () => {
    expect(CONSENT_STORAGE_KEY).toBe("dojo-analytics-consent");
  });
});
