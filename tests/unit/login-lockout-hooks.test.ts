import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import {
  lockoutAfterSignIn,
  lockoutBeforeSignIn,
  recordFailedLogin,
  type SignInHookCtx,
} from "@/lib/services/login-lockout.service";
import { canonicalAuthEmail, LOCKOUT_MESSAGE } from "@/lib/utils/lockout";

/**
 * H-1: lockout hook logic with a MOCKED prisma. Calls PRODUCTION handlers
 * (not copies). The real atomic SQL is covered by the real-Postgres lane
 * (tests/concurrency/login-lockout.pg.test.ts).
 */
function mockDb(user: { lockedUntil: Date | null } | null = null) {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue(user),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
}
// Better Auth's OWN zod (v4) instance, the one its sign-in route calls baZod.email() on.
const baZod = createRequire(`${process.cwd()}/node_modules/better-auth/package.json`)("zod") as typeof import("zod/v4");
const ctx = (email: unknown, context: SignInHookCtx["context"] = {}): SignInHookCtx => ({
  path: "/sign-in/email",
  body: { email },
  context,
});
const FAIL = { returned: { body: { code: "INVALID_EMAIL_OR_PASSWORD" } } };
const VARIANTS = ["Victim@Example.COM", "VICTIM@example.com", "victim@EXAMPLE.com", "victim@example.com"];

describe("canonicalAuthEmail matches Better Auth", () => {
  it("lowercases; does not trim (Better Auth rejects padded emails via baZod.email() before auth)", () => {
    expect(canonicalAuthEmail("Victim@Example.COM")).toBe("victim@example.com");
    // Evidence for the no-trim decision: BA validates with baZod.email() first.
    expect(baZod.email().safeParse(" victim@example.com ").success).toBe(false);
    expect(baZod.email().safeParse("Victim@Example.COM").success).toBe(true);
  });
});

describe("before-hook: case variants all hit the SAME lockout row", () => {
  it.each(VARIANTS)("locked account is rejected for %s", async (v) => {
    const db = mockDb({ lockedUntil: new Date(Date.now() + 60_000) });
    await expect(lockoutBeforeSignIn(ctx(v), db as never)).rejects.toMatchObject({
      body: { message: LOCKOUT_MESSAGE },
    });
    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "victim@example.com" } })
    );
  });

  it("unknown user / expired lock / other path / DB error all pass through", async () => {
    await expect(lockoutBeforeSignIn(ctx("a@b.com"), mockDb(null) as never)).resolves.toBeUndefined();
    await expect(
      lockoutBeforeSignIn(ctx("a@b.com"), mockDb({ lockedUntil: new Date(Date.now() - 1) }) as never)
    ).resolves.toBeUndefined();
    const db = mockDb();
    await lockoutBeforeSignIn({ ...ctx("a@b.com"), path: "/sign-up/email" }, db as never);
    expect(db.user.findUnique).not.toHaveBeenCalled();
    db.user.findUnique.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(lockoutBeforeSignIn(ctx("a@b.com"), db as never)).resolves.toBeUndefined();
  });
});

describe("after-hook", () => {
  it.each(VARIANTS)("failure for %s increments the canonical account atomically", async (v) => {
    const db = mockDb();
    await lockoutAfterSignIn(ctx(v, FAIL), db as never);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    // tagged-template args: (strings, threshold, threshold, cooldownMs, email)
    const args = db.$executeRaw.mock.calls[0];
    expect(args[args.length - 1]).toBe("victim@example.com");
    expect(db.user.findUnique).not.toHaveBeenCalled(); // no read-then-write
  });

  it("success resets the canonical row", async () => {
    const db = mockDb();
    await lockoutAfterSignIn(ctx("Victim@Example.COM", { newSession: {} }), db as never);
    expect(db.user.updateMany).toHaveBeenCalledWith({
      where: { email: "victim@example.com" },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it("EMAIL_NOT_VERIFIED and other outcomes do NOT count", async () => {
    const db = mockDb();
    await lockoutAfterSignIn(ctx("a@b.com", { returned: { body: { code: "EMAIL_NOT_VERIFIED" } } }), db as never);
    await lockoutAfterSignIn(ctx("a@b.com", {}), db as never);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it("increment DB failure is swallowed (fail-safe)", async () => {
    const db = mockDb();
    db.$executeRaw.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(lockoutAfterSignIn(ctx("a@b.com", FAIL), db as never)).resolves.toBeUndefined();
  });

  it("recordFailedLogin returns affected rows (0 for unknown email: no enumeration)", async () => {
    const db = mockDb();
    db.$executeRaw.mockResolvedValue(0);
    await expect(recordFailedLogin(db as never, "Nobody@x.com")).resolves.toBe(0);
  });
});
