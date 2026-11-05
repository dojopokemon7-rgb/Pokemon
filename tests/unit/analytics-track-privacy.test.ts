import { describe, expect, it } from "vitest";
import { sanitizeProps, withMoney } from "@/lib/analytics/track";

/**
 * Item 8 regression: event properties must never carry PII/secrets, and money
 * props must stay honest — value_inr only appears when a real USD->INR rate
 * exists (never 0, never a guess; RULE 2).
 */
describe("sanitizeProps privacy (item 8)", () => {
  it("drops email, password, otp, token and whole-token variants", () => {
    const out = sanitizeProps({
      email: "a@b.com",
      password: "hunter2",
      otp: "123456",
      token: "abc",
      access_token: "xyz",
      user_email: "c@d.com",
    });
    expect(out).toEqual({});
  });

  it("drops undefined and non-finite numbers (NaN/Infinity)", () => {
    const out = sanitizeProps({
      skipped: undefined,
      bad: NaN,
      worse: Infinity,
      value_usd: 12.5,
    });
    expect(out).toEqual({ value_usd: 12.5 });
    expect("skipped" in out).toBe(false);
    expect("bad" in out).toBe(false);
    expect("worse" in out).toBe(false);
  });

  it("keeps safe keys untouched", () => {
    const out = sanitizeProps({
      card_id: "base1-4",
      value_usd: 9.99,
      game: "pokemon",
      quantity: 2,
      hasPrice: true,
    });
    expect(out).toEqual({
      card_id: "base1-4",
      value_usd: 9.99,
      game: "pokemon",
      quantity: 2,
      hasPrice: true,
    });
  });
});

describe("withMoney INR gating (item 8/10)", () => {
  it("adds currency USD and value_inr when a real rate exists", () => {
    const out = withMoney({ value_usd: 10 }, 83);
    expect(out.currency).toBe("USD");
    expect(out.value_inr).toBe(830);
  });

  it("omits value_inr entirely when the rate is null", () => {
    const out = withMoney({ value_usd: 10 }, null);
    expect(out.currency).toBe("USD");
    expect("value_inr" in out).toBe(false);
  });

  it("is a no-op when value_usd is absent or non-finite", () => {
    const noUsd = { game: "pokemon" };
    expect(withMoney(noUsd, 83)).toBe(noUsd);

    const badUsd = { value_usd: NaN };
    expect(withMoney(badUsd, 83)).toBe(badUsd);
  });
});
