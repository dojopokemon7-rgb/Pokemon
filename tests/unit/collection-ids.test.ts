import { describe, it, expect } from "vitest";
import { UNCAT_ID, toHistoryToken } from "@/lib/utils/collection-ids";

/**
 * dashboard-chart key-path fix — the one runnable check the token translation
 * leaves behind. If `toHistoryToken` stops mapping "__uncat__" → "null" (or
 * starts mangling named cuids / "all"), the loose bucket silently fails to
 * plot again; this fails loudly instead.
 */
describe("collection-ids.toHistoryToken", () => {
  it("maps the loose-bucket sentinel to the service's null token", () => {
    expect(toHistoryToken(UNCAT_ID)).toBe("null");
    expect(toHistoryToken("__uncat__")).toBe("null");
  });

  it("passes a named-collection cuid through unchanged", () => {
    expect(toHistoryToken("ckx123abc")).toBe("ckx123abc");
  });

  it("passes the 'all' token through unchanged", () => {
    expect(toHistoryToken("all")).toBe("all");
  });

  it("UNCAT_ID is the UI sentinel '__uncat__'", () => {
    expect(UNCAT_ID).toBe("__uncat__");
  });
});
