import { describe, it, expect } from "vitest";
import { canFlushNonAdmins } from "@/lib/utils/flush-guard";

/**
 * The runnable check behind the destructive non-admin flush
 * (scripts/flush-nonadmin-users.ts): the flush must refuse to run if it would
 * leave zero admins, and must allow it when at least one admin remains.
 */
describe("canFlushNonAdmins", () => {
  it("refuses when zero admins would remain (all-non-admin set)", () => {
    const result = canFlushNonAdmins({ adminCount: 0, nonAdminCount: 42 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("allows when at least one admin remains", () => {
    expect(canFlushNonAdmins({ adminCount: 1, nonAdminCount: 42 }).allowed).toBe(true);
    expect(canFlushNonAdmins({ adminCount: 3, nonAdminCount: 0 }).allowed).toBe(true);
  });
});
