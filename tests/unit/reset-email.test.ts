import { describe, it, expect } from "vitest";
import { chooseResetDelivery } from "@/lib/utils/reset-email";

/**
 * Guards the password-reset delivery decision: send when a provider is
 * configured, log the link only in dev, and in prod WITHOUT a provider
 * fall to an explicit error state rather than a silent success.
 */
describe("chooseResetDelivery", () => {
  it("sends when a provider is configured (regardless of env)", () => {
    expect(chooseResetDelivery({ hasProvider: true, nodeEnv: "production" })).toBe("send");
    expect(chooseResetDelivery({ hasProvider: true, nodeEnv: "development" })).toBe("send");
  });

  it("logs the link in development when no provider is configured", () => {
    expect(chooseResetDelivery({ hasProvider: false, nodeEnv: "development" })).toBe("dev-log");
  });

  it("reports prod-unconfigured in production with no provider", () => {
    expect(chooseResetDelivery({ hasProvider: false, nodeEnv: "production" })).toBe(
      "prod-unconfigured"
    );
  });

  it("treats an undefined NODE_ENV without a provider as prod-unconfigured", () => {
    expect(chooseResetDelivery({ hasProvider: false, nodeEnv: undefined })).toBe(
      "prod-unconfigured"
    );
  });
});
