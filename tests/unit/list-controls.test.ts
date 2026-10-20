import { describe, it, expect } from "vitest";
import { paramOrDefault } from "@/lib/utils/list-controls";

/**
 * BUG 2 — the pure control↔URL validation shared by the portfolio + search
 * pages. Pins that a known param is honored and an absent/unknown one falls
 * back to the control's default (so a deep link can't drive the control to an
 * invalid value, and a fresh load with no param uses the default).
 */

const CARD_TYPES = ["active", "sold", "all", "want-to-buy", "high-value"] as const;
const SORTS = ["trending", "market_desc", "market_asc", "name_asc"] as const;
const VIEWS = ["grid", "list"] as const;

describe("paramOrDefault", () => {
  it("portfolio cardType: ?type=sold → 'sold'", () => {
    expect(paramOrDefault("sold", CARD_TYPES, "active")).toBe("sold");
  });

  it("portfolio cardType: unknown/absent → default 'active'", () => {
    expect(paramOrDefault("bogus", CARD_TYPES, "active")).toBe("active");
    expect(paramOrDefault(null, CARD_TYPES, "active")).toBe("active");
    expect(paramOrDefault(undefined, CARD_TYPES, "active")).toBe("active");
  });

  it("search sort: ?sort=market_desc → 'market_desc', unknown → 'trending'", () => {
    expect(paramOrDefault("market_desc", SORTS, "trending")).toBe("market_desc");
    expect(paramOrDefault("", SORTS, "trending")).toBe("trending");
    expect(paramOrDefault("nope", SORTS, "trending")).toBe("trending");
  });

  it("view: ?view=grid → 'grid', unknown → default 'list'", () => {
    expect(paramOrDefault("grid", VIEWS, "list")).toBe("grid");
    expect(paramOrDefault(null, VIEWS, "list")).toBe("list");
  });
});
