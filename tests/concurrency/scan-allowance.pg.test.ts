/**
 * REAL PostgreSQL concurrency test for reserveSuccessfulScan
 * (src/lib/services/scan-allowance.service.ts — Phase 2 remediation).
 *
 * WHAT THIS PROVES
 * ----------------
 * The scan allowance is reserved with a single ATOMIC conditional update
 * (`user.updateMany where { id, scanCount: { lt: limit } }`). The mocked unit
 * suite proves the handler maps `count === 1` to ok / `count === 0` to refuse,
 * but a mock cannot prove the GUARD holds under genuinely parallel database
 * connections — that is a property of Postgres' row-level write locking. This
 * fires TWO concurrent reservations from two INDEPENDENT PrismaClient pools
 * (Promise.all → real connection-level overlap) against a user seeded at
 * scanCount = limit - 1, and asserts exactly ONE wins and scanCount ends at the
 * limit, never over it (no over-grant of the last scan slot).
 *
 * APPROACH — REPLICATED GUARDED SQL (not the HTTP handler)
 * --------------------------------------------------------
 * The route reads the @/lib/db PrismaClient SINGLETON, so two concurrent handler
 * calls share ONE pool and cannot genuinely contend on separate connections —
 * precisely the race we must prove safe. We therefore replicate the service's
 * EXACT guarded update verbatim in `runReserve()` and drive it through two
 * independent clients, mirroring the sibling sale concurrency harness.
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

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB_URL ? describe : describe.skip;

// A fixed limit for the scenario — independent of the SCAN_LIMIT env so the test
// is deterministic regardless of the ambient configuration.
const LIMIT = 10;
const USER_ID = "pgtest-scan-user";

let clientA: PrismaClient;
let clientB: PrismaClient;
let admin: PrismaClient;

function makeClient(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: TEST_DB_URL } }, log: ["error"] });
}

/**
 * The EXACT guarded reservation from reserveSuccessfulScan(), replicated
 * verbatim so the test drives the identical SQL the service emits. Returns
 * ok === true only when this call incremented the counter (count === 1).
 */
async function runReserve(db: PrismaClient): Promise<{ ok: boolean }> {
  const res = await db.user.updateMany({
    where: { id: USER_ID, scanCount: { lt: LIMIT } },
    data: { scanCount: { increment: 1 } },
  });
  return { ok: res.count === 1 };
}

describeDb("PostgreSQL concurrency — reserveSuccessfulScan atomic allowance guard", () => {
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

  it("two concurrent reservations on the last slot → exactly ONE ok, scanCount == limit (never over)", async () => {
    const [a, b] = await Promise.all([runReserve(clientA), runReserve(clientB)]);

    // Exactly one winner — the loser's guarded updateMany matched 0 rows.
    const wins = [a.ok, b.ok].filter(Boolean).length;
    expect(wins).toBe(1);

    // The counter lands EXACTLY on the limit — the over-grant is impossible.
    const user = await admin.user.findUnique({ where: { id: USER_ID }, select: { scanCount: true } });
    expect(user?.scanCount).toBe(LIMIT);
    expect(user!.scanCount).toBeLessThanOrEqual(LIMIT); // explicit no-overrun assertion
  });

  it("a reservation at the limit refuses (count 0) and never increments past the limit", async () => {
    // Already at the ceiling.
    await admin.user.update({ where: { id: USER_ID }, data: { scanCount: LIMIT } });

    const res = await runReserve(clientA);
    expect(res.ok).toBe(false);

    const user = await admin.user.findUnique({ where: { id: USER_ID }, select: { scanCount: true } });
    expect(user?.scanCount).toBe(LIMIT); // unchanged — no overrun
  });
});
