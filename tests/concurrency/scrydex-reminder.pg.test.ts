/**
 * REAL PostgreSQL concurrency test for the PRODUCTION runScrydexReminder claim
 * (src/lib/services/scrydex-reminder.service.ts). Two concurrent runs, each via
 * its OWN PrismaClient pool, on a due day must produce exactly ONE claim row and
 * ONE send (P2002 on the deterministic verification id). SES + Scrydex usage are
 * mocked. Reads ONLY TEST_DATABASE_URL (disposable Docker pg from
 * scripts/concurrency-test.mjs); skipped when unset. Never touches the repo .env.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

const send = vi.hoisted(() => vi.fn());
vi.mock("@/lib/utils/ses-email", () => ({ sendSesEmail: send }));
vi.mock("@/lib/services/scrydex-usage.service", () => ({
  getScrydexUsage: vi.fn(async () => null),
  readCachedUsage: vi.fn(),
}));
import { runScrydexReminder } from "@/lib/services/scrydex-reminder.service";

const URL_ = process.env.TEST_DATABASE_URL;
const describeDb = URL_ ? describe : describe.skip;
const mk = () => new PrismaClient({ datasources: { db: { url: URL_ } }, log: ["error"] });
const ID = "scrydex-reminder:renewal:2026-12-15:7";
let a: PrismaClient, b: PrismaClient;

describeDb("PostgreSQL concurrency — scrydex reminder claim", () => {
  beforeAll(() => {
    a = mk();
    b = mk();
    process.env.SCRYDEX_REMINDER_ENABLED = "true";
    process.env.SCRYDEX_RENEWAL_DATE = "2026-12-15";
    process.env.SCRYDEX_LOW_CREDIT_PERCENT = "";
    process.env.SCRYDEX_REMINDER_TO = "a@x.com";
  });
  beforeEach(async () => {
    send.mockReset();
    send.mockImplementation(() => new Promise((r) => setTimeout(r, 50))); // widen the race
    await a.verification.deleteMany({ where: { id: ID } });
  });
  afterAll(async () => {
    await a.verification.deleteMany({ where: { id: ID } });
    await Promise.all([a.$disconnect(), b.$disconnect()]);
  });

  it("two concurrent runs -> exactly one claim and one send", async () => {
    const now = new Date("2026-12-08T06:00:00Z");
    const [r1, r2] = await Promise.all([
      runScrydexReminder({ now, db: a }),
      runScrydexReminder({ now, db: b }),
    ]);
    expect([r1.renewalSent, r2.renewalSent].filter(Boolean)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await a.verification.count({ where: { id: ID } })).toBe(1);
  });
});
