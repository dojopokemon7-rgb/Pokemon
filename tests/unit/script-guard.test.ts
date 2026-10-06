import { describe, it, expect } from "vitest";
import { isProdDbTarget } from "../../scripts/_guard";

/**
 * Guards the prod-DB write heuristic for the destructive one-off scripts.
 * A Supabase pooler host or NODE_ENV=production reads as prod (requires the
 * CONFIRM_PROD_WRITE override); a localhost dev URL does not.
 */
describe("isProdDbTarget", () => {
  it("is true for a Supabase pooler host", () => {
    expect(
      isProdDbTarget(
        "postgresql://postgres.ref:pw@aws-0-eu.pooler.supabase.com:6543/postgres",
        "development"
      )
    ).toBe(true);
  });

  it("is true when NODE_ENV is production, even on a localhost URL", () => {
    expect(isProdDbTarget("postgresql://postgres:pw@localhost:5432/postgres", "production")).toBe(
      true
    );
  });

  it("is false for a localhost URL in a non-prod env", () => {
    expect(isProdDbTarget("postgresql://postgres:pw@localhost:5432/postgres", "development")).toBe(
      false
    );
    expect(isProdDbTarget("postgresql://localhost:5432/postgres", undefined)).toBe(false);
    expect(isProdDbTarget("postgresql://user:pw@127.0.0.1:5432/postgres", "test")).toBe(false);
  });

  it("is false when DATABASE_URL is unset in a non-prod env", () => {
    expect(isProdDbTarget(undefined, "development")).toBe(false);
  });
});
