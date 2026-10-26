import { describe, it, expect, afterEach } from "vitest";
import {
  LOCKOUT_MESSAGE,
  isLocked,
  lockoutCooldownMs,
  lockoutThreshold,
  nextFailureState,
  resetState,
} from "@/lib/utils/lockout";

/**
 * H-2 per-account lockout — pure decision logic (src/lib/utils/lockout.ts).
 *
 * Proves the four load-bearing cases the sign-in hook relies on:
 *   - reaches threshold  → locks (counter clamped, lockedUntil = now + cooldown);
 *   - within cooldown    → isLocked true;
 *   - after cooldown     → isLocked false;
 *   - success            → counter + lock reset.
 * Plus the env-overridable knobs (read through the reader functions, mirroring
 * the rate-limit.test.ts env-override cases). The helper is pure — no DB, no
 * mocks — so every case uses a fixed `now`.
 */

// A fixed reference instant so cooldown math is deterministic.
const NOW = new Date("2025-01-01T00:00:00.000Z");

// Keep env clean between the override cases (they are the only mutators).
afterEach(() => {
  delete process.env.LOCKOUT_THRESHOLD;
  delete process.env.LOCKOUT_COOLDOWN_MINUTES;
});

describe("isLocked", () => {
  it("is false when lockedUntil is null or undefined", () => {
    expect(isLocked(null, NOW)).toBe(false);
    expect(isLocked(undefined, NOW)).toBe(false);
  });

  it("is false when lockedUntil is in the past", () => {
    expect(isLocked(new Date(NOW.getTime() - 1), NOW)).toBe(false);
  });

  it("is false when lockedUntil is exactly now (strictly-future only)", () => {
    expect(isLocked(new Date(NOW.getTime()), NOW)).toBe(false);
  });

  it("is true when lockedUntil is in the future (within cooldown)", () => {
    expect(isLocked(new Date(NOW.getTime() + 1), NOW)).toBe(true);
  });
});

describe("nextFailureState — below threshold", () => {
  it("increments from 0 → 1 and does not lock", () => {
    expect(nextFailureState({ failedLoginAttempts: 0, lockedUntil: null }, NOW)).toEqual({
      failedLoginAttempts: 1,
      lockedUntil: null,
    });
  });

  it("increments from 3 → 4 and does not lock (default threshold 5)", () => {
    expect(nextFailureState({ failedLoginAttempts: 3, lockedUntil: null }, NOW)).toEqual({
      failedLoginAttempts: 4,
      lockedUntil: null,
    });
  });
});

describe("nextFailureState — reaching threshold", () => {
  it("locks on the 5th failure: counter clamps at 5, lockedUntil = now + cooldown", () => {
    const next = nextFailureState({ failedLoginAttempts: 4, lockedUntil: null }, NOW);
    expect(next.failedLoginAttempts).toBe(5);
    expect(next.lockedUntil).not.toBeNull();
    expect(next.lockedUntil!.getTime()).toBe(NOW.getTime() + lockoutCooldownMs());
  });

  it("stays locked when already at/over threshold: counter clamped, cooldown re-stamped from now", () => {
    const next = nextFailureState(
      { failedLoginAttempts: 5, lockedUntil: new Date(NOW.getTime() - 1000) },
      NOW
    );
    // Clamped at the threshold — does not climb to 6.
    expect(next.failedLoginAttempts).toBe(5);
    // Re-stamped relative to the new `now`, so hammering a locked account keeps
    // extending the lock.
    expect(next.lockedUntil!.getTime()).toBe(NOW.getTime() + lockoutCooldownMs());
  });
});

describe("resetState — success path", () => {
  it("clears the counter and the lock", () => {
    expect(resetState()).toEqual({ failedLoginAttempts: 0, lockedUntil: null });
  });

  it("returns a fresh object each call (never a shared mutable singleton)", () => {
    expect(resetState()).not.toBe(resetState());
  });
});

describe("knobs — env override with baked-in defaults", () => {
  it("uses the baked-in defaults when env is unset (5 failures / 15 min)", () => {
    expect(lockoutThreshold()).toBe(5);
    expect(lockoutCooldownMs()).toBe(15 * 60 * 1000);
  });

  it("honors positive-integer env overrides", () => {
    process.env.LOCKOUT_THRESHOLD = "8";
    process.env.LOCKOUT_COOLDOWN_MINUTES = "30";
    expect(lockoutThreshold()).toBe(8);
    expect(lockoutCooldownMs()).toBe(30 * 60 * 1000);
  });

  it("ignores invalid env values (falls back to the defaults)", () => {
    process.env.LOCKOUT_THRESHOLD = "-5";
    process.env.LOCKOUT_COOLDOWN_MINUTES = "nope";
    expect(lockoutThreshold()).toBe(5);
    expect(lockoutCooldownMs()).toBe(15 * 60 * 1000);
  });
});

describe("LOCKOUT_MESSAGE", () => {
  it("is a non-empty generic message that never reveals password correctness", () => {
    expect(LOCKOUT_MESSAGE).toBe(
      "Account temporarily locked due to too many failed attempts. Try again later."
    );
    expect(LOCKOUT_MESSAGE.toLowerCase()).not.toContain("password");
  });
});
