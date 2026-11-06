/**
 * REAL PostgreSQL test for the PRODUCTION admin login guard
 * (src/lib/services/admin-login-guard.service.ts, M-2 + S-2). The functions under
 * test are imported and called with independent PrismaClient pools; nothing is
 * re-implemented here. Gated on TEST_DATABASE_URL (disposable local postgres:16
 * from scripts/concurrency-test.mjs; never Supabase, never the repo .env).
 *
 * Proves: atomic increments under concurrency for the PER-IP and GLOBAL
 * counters (no lost updates, exactly MAX allowed), one IP's flood never moves
 * another IP's counter and never charges the global ceiling, lock does not
 * extend while locked, expiry resets the window, resetAdminGuard clears the
 * global rows + the caller's own IP row only, and a genuinely MISSING table
 * degrades to the in-process fallback instead of throwing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  ADMIN_GUARD_MAX,
  ADMIN_GUARD_MAX_PER_IP,
  ADMIN_GUARD_WINDOW_MS,
  __resetAdminGuardMemoryForTests,
  ipKey,
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
const GLOBAL = "admin-guard:password";

describeDb("PostgreSQL — REAL admin login guard (durable, atomic, per-IP + global)", () => {
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

  it("12 concurrent attempts from ONE ip over 4 pools -> exactly 5 allowed, ip row = 12, global row = 5 (locked hits don't charge it)", async () => {
    const res = await Promise.all(
      Array.from({ length: 12 }, (_, i) => reserveAdminPasswordAttempt("198.51.100.1", pool(i)))
    );
    expect(res.filter((r) => r.allowed).length).toBe(ADMIN_GUARD_MAX_PER_IP);
    expect((await rowOf(ipKey("198.51.100.1")))!.value).toBe("12");
    expect((await rowOf(GLOBAL))!.value).toBe(String(ADMIN_GUARD_MAX_PER_IP));
  });

  it("one IP's flood does not move another IP's counter, and the other IP is still allowed", async () => {
    await Promise.all(Array.from({ length: 30 }, (_, i) => reserveAdminPasswordAttempt("198.51.100.1", pool(i))));
    expect(await rowOf(ipKey("198.51.100.2"))).toBeNull();
    const other = await reserveAdminPasswordAttempt("198.51.100.2", pool(0));
    expect(other.allowed).toBe(true);
    expect((await rowOf(ipKey("198.51.100.2")))!.value).toBe("1");
  });

  it("60 concurrent attempts from 60 distinct IPs -> global counter exact (60), exactly 40 allowed", async () => {
    const res = await Promise.all(
      Array.from({ length: 60 }, (_, i) => reserveAdminPasswordAttempt(`192.0.2.${i + 1}`, pool(i)))
    );
    expect(res.map((r) => r.count).sort((a, b) => a - b)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(res.filter((r) => r.allowed).length).toBe(ADMIN_GUARD_MAX.password);
    expect((await rowOf(GLOBAL))!.value).toBe("60");
  });

  it("mint (5) and otp (10) global caps are atomic", async () => {
    const mint = await Promise.all(Array.from({ length: 8 }, (_, i) => reserveAdminOtpMint(pool(i))));
    expect(mint.filter((r) => r.allowed).length).toBe(ADMIN_GUARD_MAX.mint);
    const otp = await Promise.all(Array.from({ length: 14 }, (_, i) => reserveAdminOtpAttempt(pool(i))));
    expect(otp.filter((r) => r.allowed).length).toBe(ADMIN_GUARD_MAX.otp);
  });

  it("attempts while locked do NOT extend the window (max lock = 15 min from the first hit)", async () => {
    await reserveAdminPasswordAttempt("198.51.100.1", pool(0));
    const id = ipKey("198.51.100.1");
    const first = (await rowOf(id))!.expiresAt.getTime();
    for (let i = 0; i < 8; i++) await reserveAdminPasswordAttempt("198.51.100.1", pool(i));
    expect((await rowOf(id))!.expiresAt.getTime()).toBe(first);
    const ms = first - Date.now();
    expect(ms).toBeGreaterThan(ADMIN_GUARD_WINDOW_MS - 60_000);
    expect(ms).toBeLessThanOrEqual(ADMIN_GUARD_WINDOW_MS);
  });

  it("an expired per-IP window starts over at 1 (auto-recovery, no permanent lock)", async () => {
    for (let i = 0; i < 8; i++) await reserveAdminPasswordAttempt("198.51.100.1", pool(i));
    await admin.verification.update({
      where: { id: ipKey("198.51.100.1") },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const r = await reserveAdminPasswordAttempt("198.51.100.1", pool(0));
    expect(r.allowed).toBe(true);
    expect((await rowOf(ipKey("198.51.100.1")))!.value).toBe("1");
  });

  it("resetAdminGuard clears global rows + the caller's own IP row only, and purges expired rows", async () => {
    await reserveAdminPasswordAttempt("198.51.100.1", pool(0));
    await reserveAdminPasswordAttempt("198.51.100.2", pool(1));
    await reserveAdminOtpMint(pool(1));
    await reserveAdminOtpAttempt(pool(2));
    await admin.verification.create({
      data: { id: "admin-guard:password:ip:203.0.113.9", identifier: "x", value: "3", expiresAt: new Date(Date.now() - 1000) },
    });
    await resetAdminGuard(pool(3), "198.51.100.1");
    const left = (await admin.verification.findMany({ where: { id: { startsWith: "admin-guard:" } } })).map((r) => r.id);
    expect(left).toEqual([ipKey("198.51.100.2")]);
  });

  it("FAIL-SAFE: with the table genuinely missing, the guard logs loudly, falls back in-process and never throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await admin.$executeRawUnsafe(`ALTER TABLE "verification" RENAME TO "verification_hidden"`);
    try {
      const rs = [];
      for (let i = 0; i < 7; i++) rs.push(await reserveAdminPasswordAttempt("198.51.100.1", pool(0)));
      expect(rs.map((r) => r.allowed)).toEqual([true, true, true, true, true, false, false]); // per-IP fallback cap
      expect((await reserveAdminPasswordAttempt("198.51.100.2", pool(0))).allowed).toBe(true); // other source unaffected
      expect(err).toHaveBeenCalledWith(expect.stringContaining("DURABLE STORE UNAVAILABLE"), expect.anything());
      await expect(resetAdminGuard(pool(0), "198.51.100.1")).resolves.toBeUndefined(); // reset also never throws
    } finally {
      await admin.$executeRawUnsafe(`ALTER TABLE "verification_hidden" RENAME TO "verification"`);
      err.mockRestore();
    }
  });
});
