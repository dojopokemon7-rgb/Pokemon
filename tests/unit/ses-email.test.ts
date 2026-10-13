import { describe, it, expect } from "vitest";
import { chooseOtpDelivery } from "@/lib/utils/ses-email";

/**
 * The one runnable check the OTP-email delivery decision leaves behind
 * (AGENTS.md RULE 11). Twin of the implicit `chooseResetDelivery` coverage:
 * a provider → send; no provider in dev → log the code; no provider anywhere
 * else → the loud code-free prod-unconfigured path.
 */
describe("chooseOtpDelivery", () => {
  it("sends when a provider is configured", () => {
    expect(chooseOtpDelivery({ hasProvider: true, nodeEnv: "development" })).toBe("send");
    expect(chooseOtpDelivery({ hasProvider: true, nodeEnv: "production" })).toBe("send");
  });

  it("dev-logs when no provider is configured in local dev", () => {
    expect(chooseOtpDelivery({ hasProvider: false, nodeEnv: "development" })).toBe("dev-log");
  });

  it("is prod-unconfigured when no provider is configured outside dev", () => {
    expect(chooseOtpDelivery({ hasProvider: false, nodeEnv: "production" })).toBe(
      "prod-unconfigured"
    );
    expect(chooseOtpDelivery({ hasProvider: false, nodeEnv: undefined })).toBe(
      "prod-unconfigured"
    );
  });
});
