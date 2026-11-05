/**
 * REAL PostgreSQL concurrency test for the Phase-1 sale-integrity fix
 * (fix commit 3ac5153 — guarded atomic-decrement sale path).
 *
 * WHAT THIS PROVES
 * ----------------
 * The sibling mocked suite (tests/integration/collection-sell.test.ts) proves
 * the HANDLER LOGIC: it maps a guarded updateMany `count:0` to 409, wraps the
 * partial decrement + sold-row create in one `$transaction`, etc. But a mock
 * cannot prove that the GUARD ITSELF holds under genuinely parallel database
 * connections — that is a property of Postgres' row-level write locking, not of
 * the TypeScript. This test exercises the guard against a LIVE Postgres with
 * TWO SEPARATE PrismaClient instances (separate connection pools) fired with
 * Promise.all so the requests genuinely overlap on distinct connections.
 *
 * APPROACH — REPLICATED GUARDED SQL (not the real HTTP handler)
 * -------------------------------------------------------------
 * We replicate the EXACT guarded SQL sequence the route runs — verbatim — in
 * `runSell()` below, and run it through Prisma against the live test DB. We do
 * NOT invoke the Next.js POST handler. Why this is the faithful choice here:
 *
 *   - The whole point of the test is CONNECTION-LEVEL overlap. The real handler
 *     reads the `@/lib/db` PrismaClient SINGLETON, so two concurrent handler
 *     calls share ONE pool — they cannot genuinely contend on separate
 *     connections, which is precisely the race we must prove safe. Driving two
 *     independent PrismaClient instances is the only way to get real parallel
 *     connections, and the task explicitly permits the replicated-SQL approach
 *     when wiring the singleton handler to the test DB would defeat that.
 *   - Redis idempotency (the handler's SETNX) is a UX dedupe, NOT the oversell
 *     defense, and would MASK the concurrency under test (identical bodies
 *     collide on the key). The guarded decrement is what we are proving, so we
 *     deliberately exclude the idempotency layer — same reasoning the handler's
 *     own comments give.
 *   - The replicated sequence is copied byte-for-byte from the route's two
 *     branches (full flip + partial `$transaction`), including the GuardMissError
 *     sentinel and the 409/500 mapping, so it exercises the identical SQL the
 *     production path emits. The route source is quoted inline at each branch.
 *
 * SAFETY
 * ------
 * This test NEVER touches the repo `.env` (which points at PRODUCTION Supabase).
 * It reads ONLY `TEST_DATABASE_URL`, injected by scripts/concurrency-test.mjs,
 * which points at a DISPOSABLE local Docker postgres:16 on port 5433. When
 * `TEST_DATABASE_URL` is unset the whole suite is SKIPPED, so normal/CI runs
 * never hit a DB and never reach Supabase.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// OPT-IN gate: without an explicit TEST_DATABASE_URL this suite is a no-op, so
// `test:unit` / `test:integration` / CI stay DB-free and can NEVER touch the
// production Supabase DB in .env.
const describeDb = TEST_DB_URL ? describe : describe.skip;

// Two INDEPENDENT clients → two separate connection pools → genuinely parallel
// connections when fired with Promise.all (the whole point of the test).
let clientA: PrismaClient;
let clientB: PrismaClient;
// A third client for seeding + reading final state, kept off the two racing
// pools so a read never competes for their connections.
let admin: PrismaClient;

const USER_ID = "pgtest-user";
const CARD_ID = "pgtest-card";
const SET_ID = "pgtest-set";

function makeClient(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: TEST_DB_URL } },
    log: ["error"],
  });
}

/**
 * The EXACT guarded sale sequence from
 * src/app/api/users/me/collection/[id]/sell/route.ts, replicated verbatim so
 * the test drives the identical SQL the production route emits. Returns an
 * HTTP-equivalent status (200 success / 409 guard miss / 500 tx failure) so the
 * assertions read like the real handler's responses.
 *
 * `failCreate` injects a sold-row create failure INSIDE the partial
 * `$transaction` to prove the decrement rolls back (scenario 5). It does so by
 * violating a real constraint (a bogus cardId → FK violation), matching the
 * route's "create fails inside the tx" path.
 */
async function runSell(
  db: PrismaClient,
  lotId: string,
  lot: { cardId: string; quantity: number; collectionId: string | null },
  quantity: number,
  grossPricePerCopy: number,
  opts: { failCreate?: boolean } = {}
): Promise<number> {
  const soldCurrency = "USD";
  const grossProceeds = grossPricePerCopy * quantity;
  const saleDate = new Date();
  const isFullSale = quantity === lot.quantity;

  try {
    if (isFullSale) {
      // --- Full sale: guarded in-place flip (route: `prisma.userCollection.updateMany`
      //     where {id,userId,isSold:false,quantity} data {isSold,soldPrice,...}). ---
      const flip = await db.userCollection.updateMany({
        where: { id: lotId, userId: USER_ID, isSold: false, quantity },
        data: { isSold: true, soldPrice: grossProceeds, soldCurrency, soldAt: saleDate },
      });
      if (flip.count === 0) throw new GuardMissError();
    } else {
      // --- Partial sale: guarded decrement + sold-row create in ONE $transaction
      //     (route: `prisma.$transaction(async (tx) => { … })`). ---
      await db.$transaction(async (tx) => {
        const dec = await tx.userCollection.updateMany({
          where: { id: lotId, userId: USER_ID, isSold: false, quantity: { gte: quantity } },
          data: { quantity: { decrement: quantity } },
        });
        if (dec.count === 0) throw new GuardMissError();

        await tx.userCollection.create({
          data: {
            userId: USER_ID,
            // Scenario 5: a bogus cardId violates the Card FK → the create throws
            // INSIDE the tx, so the just-applied decrement must roll back.
            cardId: opts.failCreate ? "does-not-exist-fk-violation" : lot.cardId,
            quantity,
            isSold: true,
            soldPrice: grossProceeds,
            soldCurrency,
            soldAt: saleDate,
            collectionId: lot.collectionId,
          },
        });
      });
    }
    return 200;
  } catch (err) {
    if (err instanceof GuardMissError) return 409;
    return 500;
  }
}

class GuardMissError extends Error {
  constructor() {
    super("sale guard miss");
    this.name = "GuardMissError";
  }
}

/** Insert a fresh active lot and return its id. */
async function seedLot(quantity: number): Promise<string> {
  const row = await admin.userCollection.create({
    data: {
      userId: USER_ID,
      cardId: CARD_ID,
      quantity,
      isSold: false,
      collectionId: null,
    },
  });
  return row.id;
}

/** Read back every row for the test user, newest first. */
async function readUserRows() {
  return admin.userCollection.findMany({
    where: { userId: USER_ID },
    orderBy: { addedAt: "desc" },
  });
}

describeDb("PostgreSQL concurrency — guarded atomic-decrement sale (fix 3ac5153)", () => {
  beforeAll(async () => {
    admin = makeClient();
    clientA = makeClient();
    clientB = makeClient();

    // FK chain: CardSet ← Card, User ← UserCollection. Seed the parents once.
    await admin.user.upsert({
      where: { id: USER_ID },
      update: {},
      create: { id: USER_ID, name: "PG Test", email: "pgtest@example.invalid" },
    });
    await admin.cardSet.upsert({
      where: { id: SET_ID },
      update: {},
      create: { id: SET_ID, externalId: "pgtest-set-ext", name: "PG Test Set" },
    });
    await admin.card.upsert({
      where: { id: CARD_ID },
      update: {},
      create: {
        id: CARD_ID,
        externalId: "pgtest-card-ext",
        name: "PG Test Card",
        number: "1",
        setId: SET_ID,
      },
    });
  });

  afterAll(async () => {
    // Clean the rows this test owns, then disconnect all pools.
    if (admin) {
      await admin.userCollection.deleteMany({ where: { userId: USER_ID } });
      await admin.card.deleteMany({ where: { id: CARD_ID } });
      await admin.cardSet.deleteMany({ where: { id: SET_ID } });
      await admin.user.deleteMany({ where: { id: USER_ID } });
    }
    await Promise.all([admin?.$disconnect(), clientA?.$disconnect(), clientB?.$disconnect()]);
  });

  beforeEach(async () => {
    // Fresh slate per scenario — remove any lots from a prior test.
    await admin.userCollection.deleteMany({ where: { userId: USER_ID } });
  });

  it("Scenario 1 — two simultaneous PARTIAL sales (3 + 3) on qty 5 cannot oversell", async () => {
    const lotId = await seedLot(5);
    const lot = { cardId: CARD_ID, quantity: 5, collectionId: null };

    const [a, b] = await Promise.all([
      runSell(clientA, lotId, lot, 3, 10),
      runSell(clientB, lotId, lot, 3, 10),
    ]);

    // Exactly one 200, one 409 — the loser's guarded decrement matched 0 rows.
    const statuses = [a, b].sort();
    expect(statuses).toEqual([200, 409]);

    const rows = await readUserRows();
    const active = rows.filter((r) => !r.isSold);
    const sold = rows.filter((r) => r.isSold);
    const soldQty = sold.reduce((s, r) => s + r.quantity, 0);

    expect(soldQty).toBeLessThanOrEqual(5); // NO oversell
    expect(soldQty).toBe(3); // the one winner sold 3
    expect(sold.length).toBe(1); // exactly ONE sold row
    expect(active.length).toBe(1);
    expect(active[0].quantity).toBe(2); // remainder is exact: 5 - 3
    // quantity conserved: active + sold == original
    expect(active[0].quantity + soldQty).toBe(5);
  });

  it("Scenario 2 — PARTIAL concurrent with FULL on qty 5 cannot both commit", async () => {
    const lotId = await seedLot(5);
    const lot = { cardId: CARD_ID, quantity: 5, collectionId: null };

    const [partial, full] = await Promise.all([
      runSell(clientA, lotId, lot, 3, 10), // partial decrement by 3
      runSell(clientB, lotId, lot, 5, 10), // full flip (exact qty 5)
    ]);

    const rows = await readUserRows();
    const active = rows.filter((r) => !r.isSold);
    const sold = rows.filter((r) => r.isSold);
    const soldQty = sold.reduce((s, r) => s + r.quantity, 0);

    expect(soldQty).toBeLessThanOrEqual(5); // NO oversell

    // Two legal interleavings, both consistent:
    //  (i)  FULL wins first → row flipped to sold qty5; PARTIAL's guard (isSold:false)
    //       misses → 409. soldQty 5, no active remainder.
    //  (ii) PARTIAL wins first → decrement to 2; FULL's guard (quantity===5) misses
    //       → 409. soldQty 3, active remainder 2.
    if (full === 200) {
      expect(partial).toBe(409);
      expect(soldQty).toBe(5);
      expect(active.length).toBe(0);
    } else {
      expect(partial).toBe(200);
      expect(full).toBe(409);
      expect(soldQty).toBe(3);
      expect(active.length).toBe(1);
      expect(active[0].quantity).toBe(2);
    }
    // isSold/quantity consistent: never an active row with quantity 0.
    expect(active.every((r) => r.quantity > 0)).toBe(true);
  });

  it("Scenario 3 — two simultaneous FULL sales flip the row exactly once", async () => {
    const lotId = await seedLot(5);
    const lot = { cardId: CARD_ID, quantity: 5, collectionId: null };

    const [a, b] = await Promise.all([
      runSell(clientA, lotId, lot, 5, 10),
      runSell(clientB, lotId, lot, 5, 10),
    ]);

    const statuses = [a, b].sort();
    expect(statuses).toEqual([200, 409]); // exactly one wins

    const rows = await readUserRows();
    const sold = rows.filter((r) => r.isSold);
    const soldQty = sold.reduce((s, r) => s + r.quantity, 0);

    expect(rows.length).toBe(1); // the SAME row flipped in place — no 2nd row
    expect(sold.length).toBe(1); // flipped once, no double flip
    expect(soldQty).toBe(5);
    expect(soldQty).toBeLessThanOrEqual(5);
  });

  it("Scenario 4 — a sale equal to remaining qty routes full/flip, never a 0-qty active row", async () => {
    // Two SEQUENTIAL partials that together consume the whole lot. The 2nd sells
    // EXACTLY the remainder, which must take the full-sale flip (quantity===lot.quantity
    // at that point), never a partial decrement that would leave an active qty-0 row.
    const lotId = await seedLot(5);

    // First partial: sell 2 of 5 → decrement, remainder 3.
    const r1 = await runSell(clientA, lotId, { cardId: CARD_ID, quantity: 5, collectionId: null }, 2, 10);
    expect(r1).toBe(200);

    let rows = await readUserRows();
    const activeAfter1 = rows.filter((r) => !r.isSold);
    expect(activeAfter1.length).toBe(1);
    expect(activeAfter1[0].quantity).toBe(3);

    // Second sale: sell the EXACT remaining 3 → full-sale branch flips the row.
    const r2 = await runSell(clientB, lotId, { cardId: CARD_ID, quantity: 3, collectionId: null }, 3, 10);
    expect(r2).toBe(200);

    rows = await readUserRows();
    const active = rows.filter((r) => !r.isSold);
    const sold = rows.filter((r) => r.isSold);
    const soldQty = sold.reduce((s, r) => s + r.quantity, 0);

    expect(soldQty).toBe(5); // 2 + 3
    expect(soldQty).toBeLessThanOrEqual(5);
    expect(active.length).toBe(0); // NO active row left — none at quantity 0
    expect(rows.every((r) => r.quantity > 0)).toBe(true); // no 0-qty row anywhere
  });

  it("Scenario 5 — sold-row create failure inside the partial tx rolls the decrement back", async () => {
    const lotId = await seedLot(5);
    const lot = { cardId: CARD_ID, quantity: 5, collectionId: null };

    // Partial sale whose sold-row create violates the Card FK → throws inside the tx.
    const status = await runSell(clientA, lotId, lot, 3, 10, { failCreate: true });
    expect(status).toBe(500); // handler maps a non-guard tx error to 500

    const rows = await readUserRows();
    const active = rows.filter((r) => !r.isSold);
    const sold = rows.filter((r) => r.isSold);

    expect(sold.length).toBe(0); // NO sold row created
    expect(active.length).toBe(1);
    expect(active[0].quantity).toBe(5); // decrement ROLLED BACK — quantity unchanged
  });
});
