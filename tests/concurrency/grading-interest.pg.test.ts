/**
 * REAL PostgreSQL test for grading_interest. Gated on TEST_DATABASE_URL
 * (disposable local postgres:16 from scripts/concurrency-test.mjs; never
 * Supabase, never the repo .env). Calls the PRODUCTION service function through
 * independent PrismaClient pools, and executes the ACTUAL migration SQL file in a
 * fresh schema to prove it applies cleanly (idempotently) and its CHECKs bite.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { GradingInterestSchema } from "@/lib/validators/grading-interest.validator";
import { upsertGradingInterest } from "@/lib/services/grading-interest.service";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB_URL ? describe : describe.skip;
const mk = () => new PrismaClient({ datasources: { db: { url: TEST_DB_URL } }, log: ["error"] });
const input = (email: string, category = "cards", volume = "1-10") =>
  GradingInterestSchema.parse({ email, category, volume, source: "grading-page" });

let admin: PrismaClient;
let pools: PrismaClient[];

describeDb("PostgreSQL — REAL grading_interest", () => {
  beforeAll(() => {
    admin = mk();
    pools = Array.from({ length: 4 }, mk);
  });
  afterAll(async () => {
    await admin.gradingInterest.deleteMany({});
    await Promise.all([admin.$disconnect(), ...pools.map((p) => p.$disconnect())]);
  });
  beforeEach(() => admin.gradingInterest.deleteMany({}));

  it("12 concurrent submits, same email in mixed case, 4 pools -> exactly ONE row (last answers win)", async () => {
    const cases = ["Ash@Example.com", " ash@example.COM", "ASH@EXAMPLE.COM"];
    const cats = ["cards", "comics", "both"];
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        upsertGradingInterest(input(cases[i % 3], cats[i % 3], i % 2 ? "11-50" : "200+"), pools[i % 4] as never)
      )
    );
    const rows = await admin.gradingInterest.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("ash@example.com");
    expect(cats).toContain(rows[0].category);
  });

  it("repeat submit updates in place: joinedAt kept, updatedAt set, answers replaced", async () => {
    await upsertGradingInterest(input("b@x.co", "cards", "1-10"), admin as never);
    const first = (await admin.gradingInterest.findFirst())!;
    expect(first.updatedAt).toBeNull();
    await upsertGradingInterest(input("B@X.co", "comics", "51-200"), admin as never);
    const rows = await admin.gradingInterest.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: "comics", volume: "51-200" });
    expect(rows[0].joinedAt.getTime()).toBe(first.joinedAt.getTime());
    expect(rows[0].updatedAt).not.toBeNull();
  });

  it("the migration SQL file applies cleanly to a FRESH schema, is idempotent, and its CHECKs/unique bite", async () => {
    const sql = readFileSync(
      join(process.cwd(), "prisma/migrations/20260101000000_add_grading_interest/migration.sql"),
      "utf8"
    );
    const stmts = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .split(/;\s*(?:\n|$)/)
      .map((s) => s.trim())
      .filter(Boolean);
    expect(stmts.length).toBe(3);
    await admin.$executeRawUnsafe('DROP SCHEMA IF EXISTS mig_test CASCADE');
    await admin.$executeRawUnsafe("CREATE SCHEMA mig_test");
    const ins = (e: string, c: string, v: string) =>
      `INSERT INTO "grading_interest" ("id","email","category","volume") VALUES ('${e}-id','${e}','${c}','${v}')`;
    const tx = (fn: (t: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<void>) =>
      admin.$transaction(async (t) => {
        await t.$executeRawUnsafe("SET LOCAL search_path TO mig_test");
        await fn(t);
      });
    await tx(async (t) => {
      for (const s of stmts) await t.$executeRawUnsafe(s);
      for (const s of stmts) await t.$executeRawUnsafe(s); // idempotent re-apply
      await t.$executeRawUnsafe(ins("ok@x.co", "both", "200+"));
      await t.$executeRawUnsafe("SAVEPOINT s1");
      await expect(t.$executeRawUnsafe(ins("a@x.co", "toys", "1-10"))).rejects.toThrow();
      await t.$executeRawUnsafe("ROLLBACK TO SAVEPOINT s1");
      await expect(t.$executeRawUnsafe(ins("b@x.co", "cards", "9"))).rejects.toThrow();
      await t.$executeRawUnsafe("ROLLBACK TO SAVEPOINT s1");
      await expect(t.$executeRawUnsafe(ins("Upper@x.co", "cards", "1-10"))).rejects.toThrow();
      await t.$executeRawUnsafe("ROLLBACK TO SAVEPOINT s1");
      await expect(
        t.$executeRawUnsafe(`INSERT INTO "grading_interest" ("id","email","category","volume") VALUES ('dup','ok@x.co','both','200+')`)
      ).rejects.toThrow();
      await t.$executeRawUnsafe("ROLLBACK TO SAVEPOINT s1");
    });
    const [{ n }] = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      "SELECT count(*)::bigint AS n FROM information_schema.tables WHERE table_schema='mig_test' AND table_name='grading_interest'"
    );
    expect(Number(n)).toBe(1);
    await admin.$executeRawUnsafe("DROP SCHEMA mig_test CASCADE");
  });
});
