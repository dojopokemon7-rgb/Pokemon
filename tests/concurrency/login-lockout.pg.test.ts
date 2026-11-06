/**
 * REAL PostgreSQL concurrency test for the PRODUCTION failed-login increment
 * (src/lib/services/login-lockout.service.ts: recordFailedLogin /
 * lockoutAfterSignIn / lockoutBeforeSignIn). Imports production code; no SQL
 * copy except the deliberately racy NEGATIVE CONTROL (test-local).
 *
 * Fires N concurrent failures from independent PrismaClient pools and asserts
 * no lost updates, case variants converge on one row, the lock engages with
 * lockedUntil in the future and the before-hook then rejects.
 * Gated on TEST_DATABASE_URL (disposable local postgres:16 only).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  lockoutAfterSignIn,
  lockoutBeforeSignIn,
  recordFailedLogin,
} from "@/lib/services/login-lockout.service";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB_URL ? describe : describe.skip;

const THRESHOLD = 5;
process.env.LOCKOUT_THRESHOLD = String(THRESHOLD);
process.env.LOCKOUT_COOLDOWN_MINUTES = "15";

const USER_ID = "pgtest-lockout-user";
const EMAIL = "pglockout-victim@example.invalid"; // stored lowercase, as Better Auth stores it
const POOLS = 4;

let admin: PrismaClient;
let pools: PrismaClient[];
const mk = () => new PrismaClient({ datasources: { db: { url: TEST_DB_URL } }, log: ["error"] });
const pool = (i: number) => pools[i % POOLS];
const row = () =>
  admin.user.findUnique({
    where: { id: USER_ID },
    select: { failedLoginAttempts: true, lockedUntil: true },
  });
const FAIL = { returned: { body: { code: "INVALID_EMAIL_OR_PASSWORD" } } };
const failCtx = (email: string) => ({ path: "/sign-in/email", body: { email }, context: FAIL });

describeDb("PostgreSQL concurrency — REAL atomic failed-login increment", () => {
  beforeAll(async () => {
    admin = mk();
    pools = Array.from({ length: POOLS }, mk);
    await admin.user.upsert({
      where: { id: USER_ID },
      update: {},
      create: { id: USER_ID, name: "PG Lockout", email: EMAIL },
    });
  });
  afterAll(async () => {
    if (admin) await admin.user.deleteMany({ where: { id: USER_ID } });
    await Promise.all([admin?.$disconnect(), ...(pools ?? []).map((p) => p.$disconnect())]);
  });
  beforeEach(async () => {
    await admin.user.update({ where: { id: USER_ID }, data: { failedLoginAttempts: 0, lockedUntil: null } });
  });

  it("below threshold: 4 concurrent failures from 4 pools → counter exactly 4, no lock (no lost updates)", async () => {
    await Promise.all(Array.from({ length: THRESHOLD - 1 }, (_, i) => recordFailedLogin(pool(i), EMAIL)));
    expect(await row()).toEqual({ failedLoginAttempts: THRESHOLD - 1, lockedUntil: null });
  });

  it("10 concurrent failures (mixed-case variants, real hook) → clamps at threshold, lockedUntil ≈ now+15min", async () => {
    const variants = ["Pglockout-Victim@Example.INVALID", EMAIL.toUpperCase(), EMAIL, "pglockout-victim@EXAMPLE.invalid"];
    const before = Date.now();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => lockoutAfterSignIn(failCtx(variants[i % 4]), pool(i)))
    );
    const r = (await row())!;
    expect(r.failedLoginAttempts).toBe(THRESHOLD);
    expect(r.lockedUntil).not.toBeNull();
    const ms = r.lockedUntil!.getTime() - before;
    expect(ms).toBeGreaterThan(14 * 60_000);
    expect(ms).toBeLessThan(16 * 60_000);
  });

  it("locked account: before-hook rejects EVERY case variant (no bypass)", async () => {
    await Promise.all(Array.from({ length: THRESHOLD }, (_, i) => recordFailedLogin(pool(i), EMAIL)));
    for (const v of ["PGLOCKOUT-VICTIM@EXAMPLE.INVALID", EMAIL, "Pglockout-Victim@example.invalid"]) {
      await expect(
        lockoutBeforeSignIn({ path: "/sign-in/email", body: { email: v }, context: {} }, pool(0))
      ).rejects.toMatchObject({ body: { message: expect.stringContaining("temporarily locked") } });
    }
  });

  it("unknown email → 0 rows updated, victim untouched", async () => {
    expect(await recordFailedLogin(pool(0), "nobody-here@example.invalid")).toBe(0);
    expect((await row())!.failedLoginAttempts).toBe(0);
  });

  it("success reset clears counter + lock via the real hook", async () => {
    await Promise.all(Array.from({ length: THRESHOLD }, (_, i) => recordFailedLogin(pool(i), EMAIL)));
    await lockoutAfterSignIn(
      { path: "/sign-in/email", body: { email: "PGLOCKOUT-VICTIM@example.invalid" }, context: { newSession: {} } },
      pool(0)
    );
    expect(await row()).toEqual({ failedLoginAttempts: 0, lockedUntil: null });
  });

  it("NEGATIVE CONTROL (test-local read-then-write): lost updates DO occur, so the positive tests are meaningful", async () => {
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));
    async function racy(db: PrismaClient) {
      const u = await db.user.findUnique({ where: { id: USER_ID }, select: { failedLoginAttempts: true } });
      const seen = u!.failedLoginAttempts;
      if (++arrived === POOLS) release();
      await barrier; // all reads precede all writes
      await db.user.update({ where: { id: USER_ID }, data: { failedLoginAttempts: seen + 1 } });
    }
    await Promise.all(Array.from({ length: POOLS }, (_, i) => racy(pool(i))));
    expect((await row())!.failedLoginAttempts).toBe(1); // 4 failures, counter says 1
  });
});
