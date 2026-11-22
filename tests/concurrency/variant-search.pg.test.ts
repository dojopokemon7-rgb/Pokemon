/**
 * REAL-Postgres check of the variant (printing) search: seeds ONE card in its
 * base + several per-printing rows (mixed real spellings, plus a row with
 * printing = NULL) and asserts the actual SQL returns exactly the right rows
 * for the explicit filter, the text-inferred filter, and the filter-options
 * list. Calls the real route handler against the real Prisma client.
 *
 * SAFETY: reads ONLY TEST_DATABASE_URL (injected by scripts/concurrency-test.mjs,
 * a disposable local Docker postgres:16 on :5433; the same script also points
 * DATABASE_URL at it so the route's `@/lib/db` client uses it). Self-skips when
 * TEST_DATABASE_URL is unset, so normal runs never touch any database. Never
 * touches the repo .env (PRODUCTION).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB_URL ? describe : describe.skip;

// No Redis / auth in this lane: cache is a no-op, rate limit is open.
vi.mock("@/lib/utils/cache", () => ({ cacheGetJson: async () => null, cacheSetJson: async () => undefined }));
vi.mock("@/lib/utils/rate-limit", () => ({
  enforceRateLimit: async () => null,
  searchTier: () => ({}),
  clientIp: () => "127.0.0.1",
}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: async () => null } } }));

const SET_ID = "pgvar-set";
const SET_EXT = "pokemon-pgvar";
const ids = {
  base: "pgvar-1",
  rev: "pgvar-1::reverseHolofoil",
  holo: "pgvar-1::holofoil",
  first: "pgvar-1::firstEditionHolofoil",
  unknown: "pgvar-1::unknown",
  otherNormal: "pgvar-2",
};

let admin: PrismaClient;
const mk = (externalId: string, name: string, printing: string | null) => ({
  externalId, name, number: "1", printing, setId: SET_ID, types: [] as string[],
  imageUrl: `https://img.example/${encodeURIComponent(externalId)}.png`, marketPrice: 1,
});
const search = async (qs: string): Promise<{ status: number; ids: string[]; inferred: unknown }> => {
  const { GET } = await import("@/app/api/cards/search/route");
  const res = await GET(new Request(`http://localhost/api/cards/search?game=pokemon&${qs}`));
  const body = res.status === 200 ? await res.json() : { cards: [] };
  return { status: res.status, ids: (body.cards as { id: string }[]).map((c) => c.id).sort(), inferred: body.inferredVariant ?? null };
};

describeDb("variant search against real Postgres", () => {
  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } }, log: ["error"] });
    await admin.card.deleteMany({ where: { setId: SET_ID } });
    await admin.cardSet.deleteMany({ where: { id: SET_ID } });
    await admin.cardSet.create({ data: { id: SET_ID, externalId: SET_EXT, name: "PgVar Set" } });
    await admin.card.createMany({
      data: [
        mk(ids.base, "Pgvarmon", "normal"),
        mk(ids.rev, "Pgvarmon", "reverseHolofoil"), // camelCase spelling
        mk(ids.holo, "Pgvarmon", "Holofoil"), // odd casing
        mk(ids.first, "Pgvarmon", "firstEditionHolofoil"),
        mk(ids.unknown, "Pgvarmon", null), // not ingested per-printing
        mk(ids.otherNormal, "Otherthing", "normal"),
      ],
    });
  });
  afterAll(async () => {
    await admin.card.deleteMany({ where: { setId: SET_ID } });
    await admin.cardSet.deleteMany({ where: { id: SET_ID } });
    await admin.$disconnect();
  });

  it("explicit filter returns exactly the matching printing rows (spelling/case-insensitive)", async () => {
    expect((await search("query=pgvarmon&variant=reverse%20holofoil")).ids).toEqual([ids.rev]);
    expect((await search("query=pgvarmon&variant=reverseHolofoil")).ids).toEqual([ids.rev]);
    expect((await search("query=pgvarmon&variant=holofoil")).ids).toEqual([ids.holo]);
    expect((await search("query=pgvarmon&variant=normal")).ids).toEqual([ids.base]);
  });

  it("rows with printing = NULL never match a variant filter, but still show unfiltered", async () => {
    expect((await search("query=pgvarmon&variant=normal")).ids).not.toContain(ids.unknown);
    expect((await search("query=pgvarmon&variant=any")).ids).toContain(ids.unknown);
    expect((await search("query=pgvarmon")).ids).toContain(ids.unknown);
  });

  it("variant-only browse works and composes with the set filter + offset pagination", async () => {
    expect((await search("variant=normal&set=PgVar%20Set")).ids).toEqual([ids.base, ids.otherNormal].sort());
    expect((await search("variant=normal&set=PgVar%20Set&cursor=60")).status).toBe(404);
  });

  it("text inference: 'pgvarmon reverse holo' → the reverse holofoil row only", async () => {
    const r = await search("query=pgvarmon%20reverse%20holo&sort=market_desc");
    expect(r.ids).toEqual([ids.rev]);
    expect(r.inferred).toEqual({ value: "reverse holofoil", label: "Reverse Holo" });
    const rel = await search("query=pgvarmon%20reverse%20holo");
    expect(rel.ids).toEqual([ids.rev]);
  });

  it("text inference: '1st edition' covers firstEditionHolofoil; explicit variant wins over text", async () => {
    expect((await search("query=pgvarmon%201st%20edition&sort=market_desc")).ids).toEqual([ids.first]);
    expect((await search("query=pgvarmon%20reverse%20holo&variant=normal&sort=market_desc")).status).toBe(404);
  });

  it("filter-options lists the distinct, spelling-collapsed variants", async () => {
    const { getVariantOptions } = await import("@/lib/services/card-variants.service");
    const values = (await getVariantOptions("pokemon")).map((o) => o.value);
    for (const v of ["normal", "reverse holofoil", "holofoil", "first edition holofoil"]) expect(values).toContain(v);
    expect(values.filter((v) => v === "holofoil")).toHaveLength(1);
  });
});
