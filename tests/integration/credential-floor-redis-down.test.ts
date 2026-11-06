import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Credential floor when Redis is DOWN.
 *
 * WHAT IS REAL: the route handlers, the REAL enforceRateLimit (Redis is mocked
 * to reject every op, so the limiter genuinely FAILS OPEN and never 429s), the
 * real admin OTP store, and the real durable-guard module
 * (src/lib/services/admin-login-guard.service.ts).
 * WHAT IS MOCKED: Redis (down), SES (no email), and the database (@/lib/db is
 * made unavailable, so the guard runs on its documented in-process FALLBACK
 * counters). The durable Postgres path is proven separately against a real DB
 * (tests/concurrency/admin-login-guard.pg.test.ts).
 *
 * WHAT THIS PROVES (and what it does not):
 *  - Redis down => the per-IP limiter is open (login still reaches the
 *    credential step).
 *  - The ADMIN PASSWORD step is bounded WITHOUT Redis: after 5 attempts the
 *    window locks, even the CORRECT password gets the same 429 as a wrong one,
 *    and it recovers when the 15-min window ends (M-2).
 *  - The admin OTP has the per-nonce 5-guess lock, AND a cross-nonce cap so a
 *    repeated password step cannot reset the guess budget (M-2).
 * NOT proven here: the USER email/password lockout (see
 * tests/unit/login-lockout-hooks.test.ts + the pg lockout test) and user
 * email-OTP attempts.
 */

const ADMIN_EMAIL = "test-admin@example.com";
const ADMIN_PASSWORD = "test-admin-password-123";

type OtpArgs = { to: string; code: string; type: string };
const sesMock = vi.hoisted(() => ({
  sendOtpEmail: vi.fn(async (_args: OtpArgs): Promise<void> => {}),
}));
vi.mock("@/lib/utils/ses-email", () => sesMock);

// Redis forced DOWN: every multi().exec() rejects -> the REAL enforceRateLimit
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

// Database unavailable too (mocked lane is DB-free): guard uses its fallback.
vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: vi.fn(async () => {
      throw new Error("db down");
    }),
    verification: {
      deleteMany: vi.fn(async () => {
        throw new Error("db down");
      }),
    },
  },
}));

import { POST as loginPost } from "@/app/api/admin-auth/login/route";
import { POST as verifyPost } from "@/app/api/admin-auth/verify-otp/route";
import {
  ADMIN_GUARD_WINDOW_MS,
  __resetAdminGuardMemoryForTests,
} from "@/lib/services/admin-login-guard.service";

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
const good = () => loginReq({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
const bad = () => loginReq({ email: ADMIN_EMAIL, password: "wrong-password" });

beforeEach(() => {
  vi.clearAllMocks();
  __resetAdminGuardMemoryForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.ADMIN_SESSION_SECRET = "integration-test-admin-secret";
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_SESSION_SECRET;
});

describe("Redis down: limiter fails open, non-Redis floor still holds", () => {
  it("admin login proceeds (limiter fails open, never 429)", async () => {
    const res = await loginPost(good());
    expect(res.status).toBe(200);
    expect((await res.json()).step).toBe("otp");
  });

  it("M-2: repeated WRONG passwords lock the admin password step; the CORRECT password is then refused identically; recovers after the window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 5; i++) {
      expect((await loginPost(bad())).status).toBe(401); // limiter open => reaches the compare
    }
    const lockedWrong = await loginPost(bad());
    const lockedRight = await loginPost(good());
    expect(lockedWrong.status).toBe(429);
    expect(lockedRight.status).toBe(429); // correct password is NOT accepted during the lock
    // Uniform: wrong vs right password indistinguishable while locked.
    expect(await lockedRight.json()).toEqual(await lockedWrong.json());
    expect(sesMock.sendOtpEmail).not.toHaveBeenCalled(); // no OTP minted/emailed while locked

    // Recovery: the lock is a fixed 15-min window; it is not extended by the
    // attempts made while locked.
    vi.setSystemTime(Date.now() + ADMIN_GUARD_WINDOW_MS + 1000);
    const after = await loginPost(good());
    expect(after.status).toBe(200);
    expect(sesMock.sendOtpEmail).toHaveBeenCalledTimes(1);
  });

  it("the OTP 5-attempt per-nonce lockout still bounds brute-force while the limiter is open", async () => {
    const login = await loginPost(good());
    const nonce = cookieValue(login, "dojo_admin_login")!;
    const cookie = `dojo_admin_login=${nonce}`;
    const code = sesMock.sendOtpEmail.mock.calls.at(-1)![0].code;
    const wrong = String((Number(code[0]) + 1) % 10) + code.slice(1);

    let last!: Response;
    for (let i = 0; i < 6; i++) last = await verifyPost(verifyReq(wrong, cookie));
    expect(last.status).toBe(401);
    expect((await last.json()).relogin).toBe(true);

    const after = await verifyPost(verifyReq(code, cookie));
    expect(after.status).toBe(401);
    expect((await after.json()).relogin).toBe(true);
  });

  it("M-2: re-doing the password step does NOT reset the guess budget (cross-nonce OTP cap = 10 per window)", async () => {
    const guesses: Response[] = [];
    let lastCode = "";
    // Two logins, each exhausting its own 5-guess nonce budget = 10 wrong guesses.
    for (let n = 0; n < 2; n++) {
      const login = await loginPost(good());
      expect(login.status).toBe(200);
      const cookie = `dojo_admin_login=${cookieValue(login, "dojo_admin_login")!}`;
      lastCode = sesMock.sendOtpEmail.mock.calls.at(-1)![0].code;
      const wrong = String((Number(lastCode[0]) + 1) % 10) + lastCode.slice(1);
      for (let i = 0; i < 5; i++) guesses.push(await verifyPost(verifyReq(wrong, cookie)));
    }
    // Third login: fresh nonce, fresh per-nonce budget — but the window budget is spent.
    const login3 = await loginPost(good());
    expect(login3.status).toBe(200);
    const cookie3 = `dojo_admin_login=${cookieValue(login3, "dojo_admin_login")!}`;
    const code3 = sesMock.sendOtpEmail.mock.calls.at(-1)![0].code;
    const res = await verifyPost(verifyReq(code3, cookie3)); // the CORRECT code
    expect(res.status).toBe(429);
    expect(cookieValue(res, "dojo_admin_session")).toBeUndefined(); // no session minted
  });
});
