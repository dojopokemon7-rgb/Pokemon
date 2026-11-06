import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * M-2 admin login guard — routes + guard module with a MOCKED durable store.
 * Production code under test: the login/verify-otp routes and
 * admin-login-guard.service.ts. The fake `prisma` below stands in for Postgres:
 * it implements ONLY the contract the guard relies on (an atomic hit counter per
 * key returned by $queryRaw), so these tests prove the route/guard LOGIC, not the
 * SQL. The SQL is proven against real Postgres in
 * tests/concurrency/admin-login-guard.pg.test.ts.
 */
const ADMIN_EMAIL = "test-admin@example.com";
const ADMIN_PASSWORD = "test-admin-password-123";

const sesMock = vi.hoisted(() => ({
  sendOtpEmail: vi.fn(async (_a: { to: string; code: string; type: string }): Promise<void> => {}),
}));
vi.mock("@/lib/utils/ses-email", () => sesMock);
vi.mock("@/lib/utils/rate-limit", () => ({
  enforceRateLimit: vi.fn(async () => null),
  authTier: vi.fn(() => ({})),
  clientIp: vi.fn(() => "127.0.0.1"),
}));

// Fake durable store: counts per key (key = first interpolated value of the tagged template).
const db = vi.hoisted(() => {
  const counts = new Map<string, number>();
  const state = { down: false };
  return {
    counts,
    state,
    prisma: {
      $queryRaw: vi.fn(async (_s: TemplateStringsArray, key: string) => {
        if (state.down) throw new Error("relation \"verification\" does not exist");
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return [{ count: counts.get(key)! }];
      }),
      verification: {
        deleteMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
          if (state.down) throw new Error("down");
          for (const k of args.where.id.in) counts.delete(k);
          return { count: 0 };
        }),
      },
    },
  };
});
vi.mock("@/lib/db", () => ({ prisma: db.prisma }));

import { POST as loginPost } from "@/app/api/admin-auth/login/route";
import { POST as verifyPost } from "@/app/api/admin-auth/verify-otp/route";
import {
  ADMIN_GUARD_MAX,
  __resetAdminGuardMemoryForTests,
} from "@/lib/services/admin-login-guard.service";

const login = (password: string) =>
  loginPost(
    new Request("http://localhost/api/admin-auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password }),
    })
  );
const verify = (code: string, nonce: string) =>
  verifyPost(
    new Request("http://localhost/api/admin-auth/verify-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `dojo_admin_login=${nonce}` },
      body: JSON.stringify({ code }),
    })
  );
const nonceOf = (res: Response) => res.headers.get("set-cookie")!.match(/dojo_admin_login=([^;]*)/)![1];
const lastCode = () => sesMock.sendOtpEmail.mock.calls.at(-1)![0].code;
const wrongOf = (c: string) => String((Number(c[0]) + 1) % 10) + c.slice(1);

beforeEach(() => {
  vi.clearAllMocks();
  db.counts.clear();
  db.state.down = false;
  __resetAdminGuardMemoryForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.ADMIN_SESSION_SECRET = "integration-test-admin-secret";
});
afterEach(() => {
  delete process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_SESSION_SECRET;
});

describe("durable password guard", () => {
  it("5 wrong -> 401 each; 6th (wrong OR right) -> identical 429", async () => {
    for (let i = 0; i < ADMIN_GUARD_MAX.password; i++) expect((await login("nope")).status).toBe(401);
    const w = await login("nope");
    const r = await login(ADMIN_PASSWORD);
    expect([w.status, r.status]).toEqual([429, 429]);
    expect(await w.json()).toEqual(await r.json());
    expect(sesMock.sendOtpEmail).not.toHaveBeenCalled();
    // The durable store (not memory) did the counting.
    expect(db.counts.get("admin-guard:password")).toBe(7);
  });
});

describe("OTP mint cap (mail-bomb / budget re-mint)", () => {
  it("a correct password cannot mint more than 5 OTPs per window, even if the password counter is not the limiter", async () => {
    // Keep the password counter out of the way so ONLY the mint cap is under test.
    const orig = db.prisma.$queryRaw.getMockImplementation()!;
    db.prisma.$queryRaw.mockImplementation(async (s, key) =>
      key === "admin-guard:password" ? [{ count: 1 }] : orig(s, key)
    );
    for (let i = 0; i < ADMIN_GUARD_MAX.mint; i++) expect((await login(ADMIN_PASSWORD)).status).toBe(200);
    expect(sesMock.sendOtpEmail).toHaveBeenCalledTimes(ADMIN_GUARD_MAX.mint);
    const over = await login(ADMIN_PASSWORD);
    expect(over.status).toBe(429);
    expect(sesMock.sendOtpEmail).toHaveBeenCalledTimes(ADMIN_GUARD_MAX.mint); // no 6th email
    db.prisma.$queryRaw.mockImplementation(orig);
  });
});

describe("cross-nonce OTP cap + success reset", () => {
  it("wrong OTP guesses across nonces share one budget; correct code refused once spent", async () => {
    const orig = db.prisma.$queryRaw.getMockImplementation()!;
    db.prisma.$queryRaw.mockImplementation(async (s, key) =>
      key === "admin-guard:password" || key === "admin-guard:mint" ? [{ count: 1 }] : orig(s, key)
    );
    for (let n = 0; n < 2; n++) {
      const nonce = nonceOf(await login(ADMIN_PASSWORD));
      const wrong = wrongOf(lastCode());
      for (let i = 0; i < 5; i++) await verify(wrong, nonce);
    }
    const nonce3 = nonceOf(await login(ADMIN_PASSWORD));
    const res = await verify(lastCode(), nonce3);
    expect(res.status).toBe(429);
    expect(res.headers.get("set-cookie")).not.toContain("dojo_admin_session=ey"); // no session
    db.prisma.$queryRaw.mockImplementation(orig);
  });

  it("a full password+OTP login resets every counter", async () => {
    await login("nope");
    const nonce = nonceOf(await login(ADMIN_PASSWORD));
    expect(db.counts.get("admin-guard:password")).toBe(2);
    const ok = await verify(lastCode(), nonce);
    expect(ok.status).toBe(200);
    expect(db.prisma.verification.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["admin-guard:password", "admin-guard:mint", "admin-guard:otp"] } },
    });
    expect(db.counts.size).toBe(0);
  });
});

describe("fail-safe when the durable store is unavailable/missing", () => {
  it("logs loudly, falls back to in-process counters, never throws or locks the admin out", async () => {
    db.state.down = true;
    const ok = await login(ADMIN_PASSWORD);
    expect(ok.status).toBe(200); // admin NOT locked out by a broken store
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("DURABLE STORE UNAVAILABLE"),
      expect.anything()
    );
    // ...and the fallback still enforces the floor.
    for (let i = 0; i < ADMIN_GUARD_MAX.password; i++) await login("nope");
    expect((await login("nope")).status).toBe(429);
  });
});
