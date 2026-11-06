/**
 * REAL PostgreSQL test for the PRODUCTION admin login guard
 * (src/lib/services/admin-login-guard.service.ts, M-2). The functions under test
 * are imported and called with independent PrismaClient pools; nothing is
 * re-implemented here. Gated on TEST_DATABASE_URL (disposable local postgres:16
 * from scripts/concurrency-test.mjs; never Supabase, never the repo .env).
 *
 * Proves: atomic increments under concurrency (no lost updates, exactly MAX
 * allowed), lock does not extend while locked, expiry resets the window,
 * resetAdminGuard clears, and a genuinely MISSING table degrades to the
 * in-process fallback instead of throwing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  ADMIN_GUARD_MAX,
  ADMIN_GUARD_WINDOW_MS,
  __resetAdminGuardMemoryForTests,
  reserveAdminOtpAttempt,
  reserveAdminOtpMint,
  reserveAdminPasswordAttempt,
  resetAdminGuard,
} from "@/lib/services/admin-login-guard.service";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB_URL ? describe : describe.skip;
const POOLS = 4;
let admin: PrismaClient;
let pools: PrismaClient[];
const mk = () => new PrismaClient({ datasources: { db: { url: TEST_DB_URL } }, log: ["error"] });
const pool = (i: number) => pools[i % POOLS];
const rowOf = (id: string) => admin.verification.findUnique({ where: { id } });

describeDb("PostgreSQL — REAL admin login guard (durable, atomic)", () => {
  beforeAll(() => {
    admin = mk();
    pools = Array.from({ length: POOLS }, mk);
  });
  afterAll(async () => {
    await admin.verification.deleteMany({ where: { id: { startsWith: "admin-guard:" } } });
    await Promise.all([admin.$disconnect(), ...pools.map((p) => p.$disconnect())]);
  });
  beforeEach(async () => {
    __resetAdminGuardMemoryForTests();
    await admin.verification.deleteMany({ where: { id: { startsWith: "admin-guard:" } } });
  });

  it("12 concurrent password attempts from 4 pools -> counts are exactly 1..12 (no lost update), exactly 5 allowed", async () => {
    const res = await Promise.all(Array.from({ length: 12 }, (_, i) => reserveAdminPasswordAttempt(pool(i))));
    expect(res.map((r) => r.count).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(res.filter((r) => r.allowed).length).toBe(ADMIN_GUARD_MAX.password);
    expect((await rowOf("admin-guard:password"))!.value).toBe("12");
  });

  it("each counter has its own cap (mint 5, otp 10)", async () => {
    const mint = await Promise.all(Array.from({ length: 8 }, (_, i) => reserveAdminOtpMint(pool(i))));
    expect(mint.filter((r) => r.allowed).length).toBe(ADMIN_GUARD_MAX.mint);
    const otp = await Promise.all(Array.from({ length: 14 }, (_, i) => reserveAdminOtpAttempt(pool(i))));
    expect(otp.filter((r) => r.allowed).length).toBe(ADMIN_GUARD_MAX.otp);
  });

  it("attempts while locked do NOT extend the window (max lock = 15 min from the first hit)", async () => {
    await reserveAdminPasswordAttempt(pool(0));
    const first = (await rowOf("admin-guard:password"))!.expiresAt.getTime();
    for (let i = 0; i < 8; i++) await reserveAdminPasswordAttempt(pool(i));
    const later = (await rowOf("admin-guard:password"))!.expiresAt.getTime();
    expect(later).toBe(first);
    const ms = first - Date.now();
    expect(ms).toBeGreaterThan(ADMIN_GUARD_WINDOW_MS - 60_000);
    expect(ms).toBeLessThanOrEqual(ADMIN_GUARD_WINDOW_MS);
  });

  it("an expired window starts over at 1 (auto-recovery, no permanent lock)", async () => {
    for (let i = 0; i < 8; i++) await reserveAdminPasswordAttempt(pool(i));
    await admin.verification.update({
      where: { id: "admin-guard:password" },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const r = await reserveAdminPasswordAttempt(pool(0));
    expect(r).toEqual({ allowed: true, count: 1 });
    expect((await rowOf("admin-guard:password"))!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("resetAdminGuard (successful full login) clears every counter", async () => {
    await reserveAdminPasswordAttempt(pool(0));
    await reserveAdminOtpMint(pool(1));
    await reserveAdminOtpAttempt(pool(2));
    await resetAdminGuard(pool(3));
    expect(await admin.verification.count({ where: { id: { startsWith: "admin-guard:" } } })).toBe(0);
    expect((await reserveAdminPasswordAttempt(pool(0))).count).toBe(1);
  });

  it("FAIL-SAFE: with the table genuinely missing, the guard logs loudly, falls back in-process and never throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await admin.$executeRawUnsafe(`ALTER TABLE "verification" RENAME TO "verification_hidden"`);
    try {
      const rs = [];
      for (let i = 0; i < 7; i++) rs.push(await reserveAdminPasswordAttempt(pool(0)));
      expect(rs.map((r) => r.allowed)).toEqual([true, true, true, true, true, false, false]); // fallback still enforces the cap
      expect(err).toHaveBeenCalledWith(expect.stringContaining("DURABLE STORE UNAVAILABLE"), expect.anything());
      await expect(resetAdminGuard(pool(0))).resolves.toBeUndefined(); // reset also never throws
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "verification_hidden" RENAME TO "verification"`);
      err.mockRestore();
    }
  });
});
