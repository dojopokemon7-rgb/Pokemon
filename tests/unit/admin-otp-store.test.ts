import { describe, it, expect } from "vitest";
import { createOtpChallenge, verifyOtp, clearChallenge } from "@/lib/utils/admin-otp-store";

/**
 * Admin login OTP store — single-use, expiry, 5-attempt cap, unknown nonce.
 *
 * `verifyOtp` takes an injectable `now` so expiry is deterministic without a
 * real clock. Each test uses a unique nonce so the module-level Map doesn't
 * bleed state between cases.
 */

describe("admin-otp-store", () => {
  it("generates a 6-digit code and verifies it exactly once (single-use)", () => {
    const nonce = "n-single";
    const code = createOtpChallenge(nonce);
    expect(code).toMatch(/^\d{6}$/);

    expect(verifyOtp(nonce, code)).toEqual({ ok: true });
    // Second use fails — the challenge was consumed.
    expect(verifyOtp(nonce, code)).toEqual({ ok: false, reason: "unknown" });
  });

  it("rejects an expired code and clears it", () => {
    const nonce = "n-expired";
    const code = createOtpChallenge(nonce);
    const future = Date.now() + 11 * 60 * 1000; // > 10 min TTL
    expect(verifyOtp(nonce, code, future)).toEqual({ ok: false, reason: "expired" });
    // Cleared on expiry.
    expect(verifyOtp(nonce, code)).toEqual({ ok: false, reason: "unknown" });
  });

  it("counts wrong attempts and locks after 5 (then clears the challenge)", () => {
    const nonce = "n-locked";
    const real = createOtpChallenge(nonce);
    // A guaranteed-wrong 6-digit code (differs from the real one in digit 1).
    const wrong = String((Number(real[0]) + 1) % 10) + real.slice(1);

    // Attempts 1–4 report invalid + decreasing remaining.
    for (let i = 1; i <= 4; i++) {
      const r = verifyOtp(nonce, wrong);
      expect(r).toEqual({ ok: false, reason: "invalid", remaining: 5 - i });
    }
    // 5th wrong attempt locks and clears.
    expect(verifyOtp(nonce, wrong)).toEqual({ ok: false, reason: "locked" });
    // Challenge gone — even the correct code can't verify now.
    expect(verifyOtp(nonce, real)).toEqual({ ok: false, reason: "unknown" });
  });

  it("returns 'unknown' for a nonce with no challenge", () => {
    expect(verifyOtp("never-created", "123456")).toEqual({ ok: false, reason: "unknown" });
  });

  it("clearChallenge removes a pending challenge", () => {
    const nonce = "n-clear";
    const code = createOtpChallenge(nonce);
    clearChallenge(nonce);
    expect(verifyOtp(nonce, code)).toEqual({ ok: false, reason: "unknown" });
  });
});
