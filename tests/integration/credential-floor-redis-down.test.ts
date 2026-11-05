import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * CD-2 / credential-floor — when the fail-open rate limiter is OPEN (Redis
 * rejects every op), the brute-force floor must still hold via the NON-Redis
 * controls. This drives the REAL enforceRateLimit against a rejecting Redis
 * (so it falls open per RULE 1 — never 429) and proves the admin verify-otp
 * per-nonce 5-attempt lockout still bounds OTP brute-force independently of
 * the limiter. The limiter is the convenience cap; this in-memory lockout is
 * the actual floor.
 *
 * SES is mocked (no real email). The rate limiter is NOT mocked — only Redis is
 * forced down, so the fail-open path is exercised for real.
 */

const ADMIN_EMAIL = "test-admin@example.com";
const ADMIN_PASSWORD = "test-admin-password-123";

type OtpArgs = { to: string; code: string; type: string };
const sesMock = vi.hoisted(() => ({
  sendOtpEmail: vi.fn(async (_args: OtpArgs): Promise<void> => {}),
}));
vi.mock("@/lib/utils/ses-email", () => sesMock);

// Redis forced DOWN: every multi().exec() rejects → the REAL enforceRateLimit
// catches it and falls open (returns null = allowed), never a 429.
const redisMock = vi.hoisted(() => {
  const multi = vi.fn(() => {
    const chain = {
      incr: vi.fn(() => chain),
      expire: vi.fn(() => chain),
      exec: vi.fn(async () => {
        throw new Error("ECONNREFUSED"); // Redis down
      }),
    };
    return chain;
  });
  return { multi, ttl: vi.fn(async () => { throw new Error("ECONNREFUSED"); }) };
});
vi.mock("@/lib/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/redis")>();
  return { ...actual, redis: redisMock };
});

import { POST as loginPost } from "@/app/api/admin-auth/login/route";
import { POST as verifyPost } from "@/app/api/admin-auth/verify-otp/route";

function loginReq(body: unknown): Request {
  return new Request("http://localhost/api/admin-auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function verifyReq(code: string, cookie: string): Request {
  return new Request("http://localhost/api/admin-auth/verify-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ code }),
  });
}
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

describe("credential floor holds when the rate limiter fails open (Redis down)", () => {
  it("admin login proceeds (limiter fails open, never 429)", async () => {
    const res = await loginPost(loginReq({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }));
    // Fail-open: Redis down does NOT turn into a 429; the credential step runs.
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(429);
    expect((await res.json()).step).toBe("otp");
  });

  it("the OTP 5-attempt per-nonce lockout STILL bounds brute-force despite the open limiter", async () => {
    const login = await loginPost(loginReq({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }));
    const nonce = cookieValue(login, "dojo_admin_login")!;
    const cookie = `dojo_admin_login=${nonce}`;
    const code = sesMock.sendOtpEmail.mock.calls.at(-1)![0].code;
    const wrong = String((Number(code[0]) + 1) % 10) + code.slice(1);

    // Fire many wrong guesses. The limiter is OPEN (Redis down) so it never
    // 429s — the ONLY thing bounding the attack is the in-memory 5-attempt
    // lockout, which must still lock the nonce.
    let last!: Response;
    for (let i = 0; i < 6; i++) {
      last = await verifyPost(verifyReq(wrong, cookie));
    }
    expect(last.status).toBe(401);
    const body = await last.json();
    // Locked → forced back to the password step (the non-Redis floor engaged).
    expect(body.relogin).toBe(true);

    // And the (now-cleared) nonce can no longer verify even the CORRECT code —
    // the lockout cleared the challenge, so brute-force is bounded by it alone.
    const after = await verifyPost(verifyReq(code, cookie));
    expect(after.status).toBe(401);
    expect((await after.json()).relogin).toBe(true);
  });
});
