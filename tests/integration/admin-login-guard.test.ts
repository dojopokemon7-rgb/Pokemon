import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
/**
 * M-2 / S-2 admin login guard — routes + guard module with a MOCKED durable store.
 * Production code under test: the login/verify-otp routes, admin-otp-store and
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

// The "caller" IP is switchable per request.
const who = vi.hoisted(() => ({ ip: "203.0.113.1" }));
vi.mock("@/lib/utils/rate-limit", () => ({
  enforceRateLimit: vi.fn(async () => null),
  authTier: vi.fn(() => ({})),
  clientIp: vi.fn(() => who.ip),
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
        deleteMany: vi.fn(async (args: { where: { OR: [{ id: { in: string[] } }, unknown] } }) => {
          if (state.down) throw new Error("down");
          for (const k of args.where.OR[0].id.in) counts.delete(k);
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
  ADMIN_GUARD_MAX_PER_IP,
  __resetAdminGuardMemoryForTests,
} from "@/lib/services/admin-login-guard.service";

const A = "198.51.100.10";
const B = "198.51.100.20";
const ipRow = (ip: string) => `admin-guard:password:ip:${ip}`;

const login = (password: string, ip = who.ip) => {
  who.ip = ip;
  return loginPost(
    new Request("http://localhost/api/admin-auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: ADMIN_EMAIL, password }),
    })
  );
};
const verify = (code: string, nonce: string, ip = who.ip) => {
  who.ip = ip;
  return verifyPost(
    new Request("http://localhost/api/admin-auth/verify-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `dojo_admin_login=${nonce}` },
      body: JSON.stringify({ code }),
    })
  );
};
const nonceOf = (res: Response) => res.headers.get("set-cookie")!.match(/dojo_admin_login=([^;]*)/)![1];
const lastCode = () => sesMock.sendOtpEmail.mock.calls.at(-1)![0].code;
const wrongOf = (c: string) => String((Number(c[0]) + 1) % 10) + c.slice(1);
/** Everything an observer can compare between two responses. */
async function shape(res: Response) {
  const h: Record<string, string> = {};
  res.headers.forEach((v, k) => (h[k] = v));
  return { status: res.status, body: await res.json(), headers: h };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.counts.clear();
  db.state.down = false;
  who.ip = "203.0.113.1";
  __resetAdminGuardMemoryForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.ADMIN_SESSION_SECRET = "integration-test-admin-secret";
});
afterEach(() => {
  delete process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_SESSION_SECRET;
});

describe("S-2 per-source password guard", () => {
  it("6 wrong passwords from IP A lock A (right OR wrong -> identical 429) but the real admin on IP B still logs in", async () => {
    for (let i = 0; i < ADMIN_GUARD_MAX_PER_IP; i++) expect((await login("nope", A)).status).toBe(401);
    const w = await shape(await login("nope", A));
    const r = await shape(await login(ADMIN_PASSWORD, A));
    expect(w.status).toBe(429);
    expect(r).toEqual(w); // status, body AND headers identical: no lock-bypass oracle
    expect(sesMock.sendOtpEmail).not.toHaveBeenCalled();
    // Locked attempts never charged the GLOBAL ceiling (only the first 5 did).
    expect(db.counts.get("admin-guard:password")).toBe(ADMIN_GUARD_MAX_PER_IP);
    expect(db.counts.get(ipRow(A))).toBe(ADMIN_GUARD_MAX_PER_IP + 2);

    const real = await login(ADMIN_PASSWORD, B);
    expect(real.status).toBe(200);
    expect(sesMock.sendOtpEmail).toHaveBeenCalledTimes(1);
  });

  it("an anonymous flood from one IP cannot reach the global ceiling", async () => {
    for (let i = 0; i < 200; i++) await login("nope", A);
    expect(db.counts.get("admin-guard:password")).toBe(ADMIN_GUARD_MAX_PER_IP);
    expect((await login(ADMIN_PASSWORD, B)).status).toBe(200);
  });

  it("distributed attack: the global ceiling trips with the same uniform 429 and one warn line", async () => {
    const sources = ADMIN_GUARD_MAX.password / ADMIN_GUARD_MAX_PER_IP; // 8
    for (let s = 0; s < sources; s++)
      for (let i = 0; i < ADMIN_GUARD_MAX_PER_IP; i++) expect((await login("nope", `192.0.2.${s + 1}`)).status).toBe(401);
    const lockedWrong = await shape(await login("nope", "192.0.2.99"));
    const lockedRight = await shape(await login(ADMIN_PASSWORD, "192.0.2.98"));
    expect(lockedWrong.status).toBe(429);
    expect(lockedRight).toEqual(lockedWrong);
    expect(sesMock.sendOtpEmail).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
    const line = String((console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]);
    expect(line).not.toMatch(/192\.0\.2|@|test-admin/);
  });
});

describe("OTP mint cap (mail-bomb / budget re-mint)", () => {
  it("a correct password cannot mint more than 5 OTPs per window, even if the password counters are not the limiter", async () => {
    const orig = db.prisma.$queryRaw.getMockImplementation()!;
    db.prisma.$queryRaw.mockImplementation(async (s, key) =>
      key.startsWith("admin-guard:password") ? [{ count: 1 }] : orig(s, key)
    );
    for (let i = 0; i < ADMIN_GUARD_MAX.mint; i++) expect((await login(ADMIN_PASSWORD)).status).toBe(200);
    expect(sesMock.sendOtpEmail).toHaveBeenCalledTimes(ADMIN_GUARD_MAX.mint);
    const over = await login(ADMIN_PASSWORD);
    expect(over.status).toBe(429);
    expect(sesMock.sendOtpEmail).toHaveBeenCalledTimes(ADMIN_GUARD_MAX.mint); // no 6th email
    db.prisma.$queryRaw.mockImplementation(orig);
  });
});

describe("S-2 OTP step: nonce validated BEFORE the global budget is charged", () => {
  it("forged-nonce flood does not touch the global OTP counter, and the real admin still completes login", async () => {
    const nonce = nonceOf(await login(ADMIN_PASSWORD, B));
    const code = lastCode();
    for (let i = 0; i < 50; i++) {
      const r = await verify("123456", `forged-${i}`, A);
      expect(r.status).toBe(401); // generic relogin failure, never 429
      expect((await r.json()).relogin).toBe(true);
    }
    expect(db.counts.get("admin-guard:otp")).toBeUndefined();
    const ok = await verify(code, nonce, B);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("dojo_admin_session=");
  });

  it("wrong OTP guesses across VALID nonces still share one budget; correct code refused once spent", async () => {
    const orig = db.prisma.$queryRaw.getMockImplementation()!;
    db.prisma.$queryRaw.mockImplementation(async (s, key) =>
      key.startsWith("admin-guard:password") || key === "admin-guard:mint" ? [{ count: 1 }] : orig(s, key)
    );
    for (let n = 0; n < 2; n++) {
      const nonce = nonceOf(await login(ADMIN_PASSWORD));
      const wrong = wrongOf(lastCode());
      for (let i = 0; i < 5; i++) await verify(wrong, nonce);
    }
    const nonce3 = nonceOf(await login(ADMIN_PASSWORD));
    const res = await verify(lastCode(), nonce3);
    expect(res.status).toBe(429);
    expect(res.headers.get("set-cookie")).not.toContain("dojo_admin_session=ey");
    db.prisma.$queryRaw.mockImplementation(orig);
  });
});

describe("success reset", () => {
  it("clears the global counters and ONLY the caller's own IP row", async () => {
    await login("nope", A);
    await login("nope", B);
    const nonce = nonceOf(await login(ADMIN_PASSWORD, B));
    expect(db.counts.get("admin-guard:password")).toBe(3);
    const ok = await verify(lastCode(), nonce, B);
    expect(ok.status).toBe(200);
    expect(db.counts.has("admin-guard:password")).toBe(false);
    expect(db.counts.has("admin-guard:mint")).toBe(false);
    expect(db.counts.has(ipRow(B))).toBe(false);
    expect(db.counts.get(ipRow(A))).toBe(1); // another source's counter is untouched
  });
});

describe("fail-safe when the durable store is unavailable/missing", () => {
  it("logs loudly, falls back in-process (per-source AND global), never throws or locks the admin out", async () => {
    db.state.down = true;
    expect((await login(ADMIN_PASSWORD, B)).status).toBe(200); // admin NOT locked out by a broken store
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("DURABLE STORE UNAVAILABLE"),
      expect.anything()
    );
    // per-source floor still enforced in-process, and does not lock another source
    for (let i = 0; i < ADMIN_GUARD_MAX_PER_IP; i++) await login("nope", A);
    expect((await login("nope", A)).status).toBe(429);
    expect((await login(ADMIN_PASSWORD, "198.51.100.30")).status).toBe(200);
  });
});
