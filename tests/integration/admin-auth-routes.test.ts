import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Admin-auth routes integration (mocked SES + fail-open rate limiter — no real
 * email, no live Redis). Exercises the full isolated admin login:
 *
 *   login bad creds   → 401 generic, no OTP sent, no nonce cookie
 *   login good creds  → 200 {step:"otp"}, sendOtpEmail(to=ADMIN_EMAIL) once,
 *                       sets the dojo_admin_login nonce cookie
 *   verify good code  → 200 {ok:true}, sets dojo_admin_session cookie
 *   verify wrong code → 401 with decremented `remaining`
 *   verify 5× wrong   → 401 {relogin:true}
 *   logout            → clears the admin session cookie
 */

const ADMIN_EMAIL = "dojo.collect@nodwin.com";
const ADMIN_PASSWORD = "Dojocollect@123";

// Mock the SES sender so no real email is attempted; capture its args.
type OtpArgs = { to: string; code: string; type: string };
const sesMock = vi.hoisted(() => ({
  sendOtpEmail: vi.fn(async (_args: OtpArgs): Promise<void> => {}),
}));
vi.mock("@/lib/utils/ses-email", () => sesMock);

// Fail-open rate limiter: always allow (return null) so routing is exercised.
const rlMock = vi.hoisted(() => ({
  enforceRateLimit: vi.fn(async () => null),
  authTier: vi.fn(() => ({ bucket: "auth", limit: 10, windowSeconds: 60 })),
  clientIp: vi.fn(() => "127.0.0.1"),
}));
vi.mock("@/lib/utils/rate-limit", () => rlMock);

import { POST as loginPost } from "@/app/api/admin-auth/login/route";
import { POST as verifyPost } from "@/app/api/admin-auth/verify-otp/route";
import { POST as logoutPost } from "@/app/api/admin-auth/logout/route";

function loginReq(body: unknown): Request {
  return new Request("http://localhost/api/admin-auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function verifyReq(code: string, cookie?: string): Request {
  return new Request("http://localhost/api/admin-auth/verify-otp", {
    method: "POST",
    headers: cookie
      ? { "Content-Type": "application/json", cookie }
      : { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

/** Pulls a Set-Cookie `name=value` for the given cookie name off a response. */
function cookieValue(res: Response, name: string): string | undefined {
  const header = res.headers.get("set-cookie");
  if (!header) return undefined;
  const m = header.match(new RegExp(`${name}=([^;]*)`));
  return m?.[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.ADMIN_SESSION_SECRET = "integration-test-admin-secret";
});
afterEach(() => {
  delete process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_SESSION_SECRET;
});

describe("POST /api/admin-auth/login", () => {
  it("rejects bad credentials with a generic 401 and sends no OTP", async () => {
    const res = await loginPost(loginReq({ email: ADMIN_EMAIL, password: "wrong" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid credentials");
    expect(sesMock.sendOtpEmail).not.toHaveBeenCalled();
    expect(cookieValue(res, "dojo_admin_login")).toBeUndefined();
  });

  it("accepts good credentials, emails the OTP to ADMIN_EMAIL, sets the nonce cookie", async () => {
    const res = await loginPost(loginReq({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.step).toBe("otp");
    expect(sesMock.sendOtpEmail).toHaveBeenCalledTimes(1);
    const arg = sesMock.sendOtpEmail.mock.calls[0][0];
    expect(arg.to).toBe(ADMIN_EMAIL);
    expect(arg.code).toMatch(/^\d{6}$/);
    expect(cookieValue(res, "dojo_admin_login")).toBeTruthy();
  });
});

describe("POST /api/admin-auth/verify-otp", () => {
  async function startLogin(): Promise<{ nonceCookie: string; code: string }> {
    const res = await loginPost(loginReq({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }));
    const nonce = cookieValue(res, "dojo_admin_login")!;
    const code = sesMock.sendOtpEmail.mock.calls.at(-1)![0].code;
    return { nonceCookie: `dojo_admin_login=${nonce}`, code };
  }

  it("verifies the issued code → 200 {ok:true} and sets the admin session cookie", async () => {
    const { nonceCookie, code } = await startLogin();
    const res = await verifyPost(verifyReq(code, nonceCookie));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(cookieValue(res, "dojo_admin_session")).toBeTruthy();
  });

  it("rejects a wrong code with 401 + a decremented remaining count", async () => {
    const { nonceCookie, code } = await startLogin();
    const wrong = String((Number(code[0]) + 1) % 10) + code.slice(1);
    const res = await verifyPost(verifyReq(wrong, nonceCookie));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.remaining).toBe(4);
  });

  it("locks after 5 wrong attempts → {relogin:true}", async () => {
    const { nonceCookie, code } = await startLogin();
    const wrong = String((Number(code[0]) + 1) % 10) + code.slice(1);
    let res!: Response;
    for (let i = 0; i < 5; i++) {
      res = await verifyPost(verifyReq(wrong, nonceCookie));
    }
    expect(res.status).toBe(401);
    expect((await res.json()).relogin).toBe(true);
  });

  it("401 relogin when the nonce cookie is missing", async () => {
    const res = await verifyPost(verifyReq("123456"));
    expect(res.status).toBe(401);
    expect((await res.json()).relogin).toBe(true);
  });
});

describe("POST /api/admin-auth/logout", () => {
  it("clears the admin session cookie (maxAge 0 / expired)", async () => {
    const res = await logoutPost();
    expect(res.status).toBe(200);
    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/dojo_admin_session=/);
    expect(header).toMatch(/Max-Age=0/i);
  });
});
