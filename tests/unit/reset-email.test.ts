import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chooseResetDelivery, sendResetPasswordEmail } from "@/lib/utils/reset-email";
import { sendSesEmail } from "@/lib/utils/ses-email";

vi.mock("@/lib/utils/ses-email", () => ({ sendSesEmail: vi.fn() }));

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

describe("sendResetPasswordEmail", () => {
  const URL_ = "https://dojocollect.com/api/auth/reset-password/SECRETTOKEN?callbackURL=%2Freset-password";
  const TO = "user@example.com";
  const KEYS = ["AWS_SES_REGION", "AWS_SES_ACCESS_KEY_ID", "AWS_SES_SECRET_ACCESS_KEY", "EMAIL_FROM", "RESEND_API_KEY"];
  let log: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;
  const logged = () => JSON.stringify([...log.mock.calls, ...err.mock.calls]);
  const setSes = () => {
    vi.stubEnv("AWS_SES_REGION", "eu-north-1");
    vi.stubEnv("AWS_SES_ACCESS_KEY_ID", "k");
    vi.stubEnv("AWS_SES_SECRET_ACCESS_KEY", "s");
    vi.stubEnv("EMAIL_FROM", "hello@dojocollect.com");
  };

  beforeEach(() => {
    for (const k of KEYS) vi.stubEnv(k, "");
    vi.mocked(sendSesEmail).mockReset();
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    err = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends once through SES with the link in text and html", async () => {
    setSes();
    vi.stubEnv("NODE_ENV", "production");
    await sendResetPasswordEmail({ to: TO, url: URL_ });
    expect(sendSesEmail).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(sendSesEmail).mock.calls[0][0];
    expect(arg.to).toBe(TO);
    expect(arg.subject).toBe("Reset your Dojo password");
    expect(arg.text).toContain(URL_);
    expect(arg.html).toContain("SECRETTOKEN");
    expect(arg.html).toContain("callbackURL=%2Freset-password");
    expect(logged()).not.toContain("SECRETTOKEN");
  });

  it("HTML-escapes the link", async () => {
    setSes();
    await sendResetPasswordEmail({ to: TO, url: 'https://x/?a=1&b="<z>' });
    expect(vi.mocked(sendSesEmail).mock.calls[0][0].html).toContain("a=1&amp;b=&quot;&lt;z&gt;");
  });

  it("logs the link in development when nothing is configured", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await sendResetPasswordEmail({ to: TO, url: URL_ });
    expect(sendSesEmail).not.toHaveBeenCalled();
    expect(logged()).toContain("SECRETTOKEN");
  });

  it("logs no link/token/email in production when nothing is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await sendResetPasswordEmail({ to: TO, url: URL_ });
    expect(sendSesEmail).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(1);
    expect(logged()).not.toContain("SECRETTOKEN");
    expect(logged()).not.toContain(TO);
  });

  it("swallows an SES failure and logs without token, link or email", async () => {
    setSes();
    vi.stubEnv("NODE_ENV", "production");
    vi.mocked(sendSesEmail).mockRejectedValue(new Error(`bad ${TO} ${URL_}`));
    await expect(sendResetPasswordEmail({ to: TO, url: URL_ })).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledTimes(1);
    expect(logged()).not.toContain("SECRETTOKEN");
    expect(logged()).not.toContain(TO);
  });

  it("falls back to legacy Resend only when SES is not configured", async () => {
    vi.stubEnv("RESEND_API_KEY", "rk");
    vi.stubEnv("EMAIL_FROM", "hello@dojocollect.com");
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    await sendResetPasswordEmail({ to: TO, url: URL_ });
    vi.unstubAllGlobals();
    expect(sendSesEmail).not.toHaveBeenCalled();
    expect(f).toHaveBeenCalledTimes(1);
  });
});