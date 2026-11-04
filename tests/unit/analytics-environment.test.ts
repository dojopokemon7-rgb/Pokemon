import { describe, it, expect } from "vitest";
import { analyticsEnvironment } from "@/lib/analytics/environment";

describe("analyticsEnvironment", () => {
  it("maps hostnames", () => {
    expect(analyticsEnvironment("localhost")).toBe("development");
    expect(analyticsEnvironment("staging.dojocollect.com")).toBe("staging");
    expect(analyticsEnvironment("dojocollect.com")).toBe("production");
    expect(analyticsEnvironment("www.dojocollect.com")).toBe("production");
    expect(analyticsEnvironment("example.com")).toBe("unknown");
  });
});
