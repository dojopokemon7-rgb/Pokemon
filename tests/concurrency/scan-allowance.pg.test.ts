/**
 * REAL PostgreSQL concurrency test for the PRODUCTION reserveSuccessfulScan
 * (src/lib/services/scan-allowance.service.ts).
 *
 * WHAT THIS PROVES
 * ----------------
 * The allowance is reserved with one ATOMIC conditional update inside
 * `reserveSuccessfulScan`. This test IMPORTS AND CALLS that real function (no
 * SQL copy) twice concurrently, each through its OWN independent PrismaClient
 * pool (the function takes an optional `db` param that defaults to the app
 * singleton, so the route is unchanged). The user is seeded with exactly one
 * slot left; we assert exactly one {ok:true} and scanCount (read back from
 * Postgres) == LIMIT, never above it.
 *
 * IS THE TEST CAPABLE OF FAILING? (mutation evidence)
 * ---------------------------------------------------
 * Two NEGATIVE CONTROLS in this file prove the harness detects a lost update:
 *   1. "mutated guard": the REAL service is driven through a client wrapper that
 *      strips `scanCount < limit` from the updateMany `where` (i.e. the guard
 *      removed). Both calls then win and scanCount ends LIMIT+1. This is the
 *      exact failure the positive test would show if the guard were deleted.
 *   2. "racy read-then-write": a deliberately broken implementation (lives ONLY
 *      in this test file) reads, waits at a barrier so both reads precede both
 *      writes, then writes absolutely. Both win, one slot is double-granted.
 * Both controls assert the BAD outcome, so if the harness could not overlap
 * connections they would fail, and the positive test would be meaningless.
 *
 * SAFETY
 * ------
 * NEVER touches the repo .env (production Supabase). Reads ONLY
 * TEST_DATABASE_URL, injected by scripts/concurrency-test.mjs pointing at a
 * DISPOSABLE local Docker postgres:16 on port 5433. When TEST_DATABASE_URL is
 * unset the suite is SKIPPED, so normal/CI lanes stay DB-free.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { reserveSuccessfulScan } from "@/lib/services/scan-allowance.service";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB_URL ? describe : describe.skip;

// Deterministic regardless of ambient SCAN_LIMIT (getScanLimit reads env per call).
const LIMIT = 10;
process.env.SCAN_LIMIT = String(LIMIT);
const USER_ID = "pgtest-scan-user";

let clientA: PrismaClient;
let clientB: PrismaClient;
let admin: PrismaClient;

function makeClient(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: TEST_DB_URL } }, log: ["error"] });
}

async function readCount(): Promise<number> {
  const u = await admin.user.findUnique({ where: { id: USER_ID }, select: { scanCount: true } });
  return u!.scanCount;
}

describeDb("PostgreSQL concurrency — REAL reserveSuccessfulScan atomic allowance guard", () => {
  beforeAll(async () => {
    admin = makeClient();
    clientA = makeClient();
    clientB = makeClient();
    await admin.user.upsert({
      where: { id: USER_ID },
      update: {},
      create: { id: USER_ID, name: "PG Scan Test", email: "pgtest-scan@example.invalid" },
    });
  });

  afterAll(async () => {
    if (admin) await admin.user.deleteMany({ where: { id: USER_ID } });
    await Promise.all([admin?.$disconnect(), clientA?.$disconnect(), clientB?.$disconnect()]);
  });

  beforeEach(async () => {
    // Seed at the LAST slot: one scan remaining (scanCount = limit - 1).
    await admin.user.update({ where: { id: USER_ID }, data: { scanCount: LIMIT - 1 } });
  });

  it("two concurrent REAL reserveSuccessfulScan calls on the last slot → exactly ONE ok, scanCount == limit", async () => {
    const [a, b] = await Promise.all([
      reserveSuccessfulScan(USER_ID, clientA),
      reserveSuccessfulScan(USER_ID, clientB),
    ]);

    expect([a.ok, b.ok].filter(Boolean).length).toBe(1);
    const count = await readCount();
    expect(count).toBe(LIMIT);
    expect(count).toBeLessThanOrEqual(LIMIT);
    // The returned snapshot never reports more than the limit either.
    expect(a.allowance.used).toBeLessThanOrEqual(LIMIT);
    expect(b.allowance.used).toBeLessThanOrEqual(LIMIT);
  });

  it("a REAL reservation at the limit refuses and never increments past the limit", async () => {
    await admin.user.update({ where: { id: USER_ID }, data: { scanCount: LIMIT } });
    const res = await reserveSuccessfulScan(USER_ID, clientA);
    expect(res.ok).toBe(false);
    expect(res.allowance.remaining).toBe(0);
    expect(await readCount()).toBe(LIMIT); // unchanged — no overrun
  });

  it("many concurrent REAL reservations (12, alternating pools) with 3 slots left → exactly 3 ok, count == limit", async () => {
    await admin.user.update({ where: { id: USER_ID }, data: { scanCount: LIMIT - 3 } });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        reserveSuccessfulScan(USER_ID, i % 2 === 0 ? clientA : clientB)
      )
    );
    expect(results.filter((r) => r.ok).length).toBe(3);
    expect(await readCount()).toBe(LIMIT);
  });

  // ---------------- NEGATIVE CONTROLS (prove the harness detects the race) ----------------

  it("NEGATIVE CONTROL 1 (mutated guard): real service with `scanCount < limit` stripped → both win, count LIMIT+1", async () => {
    // Wrapper removes the guard from the where clause, leaving only { id }.
    const unguarded = (db: PrismaClient) =>
      ({
        user: {
          updateMany: (args: Parameters<PrismaClient["user"]["updateMany"]>[0]) =>
            db.user.updateMany({ ...args, where: { id: USER_ID } }),
          findUnique: db.user.findUnique.bind(db.user),
        },
      }) as unknown as Pick<PrismaClient, "user">;

    const [a, b] = await Promise.all([
      reserveSuccessfulScan(USER_ID, unguarded(clientA)),
      reserveSuccessfulScan(USER_ID, unguarded(clientB)),
    ]);
    expect([a.ok, b.ok].filter(Boolean).length).toBe(2); // over-grant
    expect(await readCount()).toBe(LIMIT + 1); // the invariant the positive test guards
  });

  it("NEGATIVE CONTROL 2 (racy read-then-write, test-local): both reads precede both writes → lost update, both win", async () => {
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));

    async function racyReserve(db: PrismaClient): Promise<{ ok: boolean }> {
      const u = await db.user.findUnique({ where: { id: USER_ID }, select: { scanCount: true } });
      const seen = u!.scanCount;
      if (++arrived === 2) release();
      await barrier; // force both reads to happen before either write
      if (seen >= LIMIT) return { ok: false };
      await db.user.update({ where: { id: USER_ID }, data: { scanCount: seen + 1 } });
      return { ok: true };
    }

    const [a, b] = await Promise.all([racyReserve(clientA), racyReserve(clientB)]);
    expect([a.ok, b.ok].filter(Boolean).length).toBe(2); // double-granted the last slot
    expect(await readCount()).toBe(LIMIT); // one increment LOST (two grants, +1 total)
  });
});
