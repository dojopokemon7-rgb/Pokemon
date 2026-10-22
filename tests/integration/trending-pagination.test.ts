import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Audit 02 F-J — /api/cards/trending page 1 (curated) vs page 2+ must be
 * DISJOINT and GAPLESS.
 *
 * The bug: page 1 of the `trending` sort is R ranked-by-recent-adds cards +
 * (limit - R) newest-by-updatedAt backfill; the OLD page 2 restarted at
 * `skip: offset` over the PLAIN updatedAt-desc catalog. Ranked cards that
 * ALSO sat in the top-`limit` by updatedAt REAPPEARED on page 2 (client
 * de-dupe hid them → page 2 looked short), and up to R non-ranked cards
 * between the backfill end and `limit` were NEVER shown.
 *
 * The fix: page 2+ fetches updatedAt-desc MINUS rankedIds
 * (`where.id.notIn = rankedIds`), offset-shifted left by rankedIds.length
 * (`skip = offset - rankedIds.length`). This test models a catalog whose
 * updatedAt-desc order begins with the ranked ids (the worst case for the
 * old code) and asserts the two pages are disjoint and leave no gap.
 *
 * Prisma + Redis are MOCKED (no live DB/network): Redis reads return null so
 * the live query path runs; `userCollection.groupBy` returns the ranked set;
 * `card.findMany` is driven off its own args so page 1 (ranked `in` + backfill
 * `notIn`) and page 2 (`notIn` + offset-shift) are simulated over one fixed
 * updatedAt-desc ordering.
 */

const prismaMock = vi.hoisted(() => ({
  card: { count: vi.fn(), findMany: vi.fn() },
  userCollection: { groupBy: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const redisMock = vi.hoisted(() => ({
  get: vi.fn(async (_k: string): Promise<string | null> => null),
  set: vi.fn(async (..._a: unknown[]) => undefined),
}));
vi.mock("@/lib/redis", () => ({ redis: redisMock }));

import { GET } from "@/app/api/cards/trending/route";

const LIMIT = 10;

// A trending row as narrowed by TRENDING_SELECT.
const row = (id: string) => ({
  id,
  externalId: id,
  name: id,
  imageUrl: "u",
  imageUrlHi: null,
  marketPrice: 10,
  printing: null,
  currentPrices: [],
  rarity: null,
  weeklyChangePct: null,
  set: { name: "Base" },
});

// The seeded catalog in updatedAt-desc order. The first 3 ids are ALSO the
// ranked set (the worst case: a naive skip:offset page 2 would re-serve them).
const RANKED = ["r1", "r2", "r3"];
const CATALOG = [...RANKED, ...Array.from({ length: 21 }, (_, i) => `c${i + 4}`)];
// catalog = r1,r2,r3,c4,c5,...,c24  (24 distinct rows)

// Drive findMany off its own args so one fixed ordering serves every branch:
//  - page 1 ranked read:   where.id.in  → those ids, in catalog order
//  - page 1 backfill read:  where.id.notIn + take → catalog minus notIn, sliced
//  - page 2 read:           where.id.notIn + skip/take → same, offset-shifted
const findManyFromArgs = (args: {
  where?: { id?: { in?: string[]; notIn?: string[] } };
  skip?: number;
  take?: number;
}) => {
  const idIn = args.where?.id?.in;
  const idNotIn = args.where?.id?.notIn;
  let pool = CATALOG;
  if (idIn) pool = CATALOG.filter((id) => idIn.includes(id));
  if (idNotIn) pool = pool.filter((id) => !idNotIn.includes(id));
  const skip = args.skip ?? 0;
  const sliced = args.take != null ? pool.slice(skip, skip + args.take) : pool.slice(skip);
  return sliced.map(row);
};

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockResolvedValue(null);
  prismaMock.userCollection.groupBy.mockResolvedValue(
    RANKED.map((cardId) => ({ cardId, _count: { cardId: 1 } }))
  );
  prismaMock.card.count.mockResolvedValue(CATALOG.length);
  prismaMock.card.findMany.mockImplementation(async (args: unknown) =>
    findManyFromArgs(args as Parameters<typeof findManyFromArgs>[0])
  );
});

const call = (qs: string) =>
  GET(new Request(`http://localhost/api/cards/trending?${qs}`));
const idsOf = (body: { cards: { id: string }[] }) => body.cards.map((c) => c.id);

describe("GET /api/cards/trending — page 1 vs page 2 (F-J)", () => {
  it("(a) page 1 and page 2 return DISJOINT id sets (no repeat)", async () => {
    const page1 = await (await call(`game=pokemon&limit=${LIMIT}`)).json();
    const page2 = await (await call(`game=pokemon&limit=${LIMIT}&cursor=${LIMIT}`)).json();

    const ids1 = idsOf(page1);
    const ids2 = idsOf(page2);
    expect(ids1).toHaveLength(LIMIT);
    expect(ids2).toHaveLength(LIMIT);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });

  it("(b) no plain card is skipped — union(page1, page2) == first 2*LIMIT distinct catalog cards", async () => {
    const page1 = await (await call(`game=pokemon&limit=${LIMIT}`)).json();
    const page2 = await (await call(`game=pokemon&limit=${LIMIT}&cursor=${LIMIT}`)).json();

    const union = [...idsOf(page1), ...idsOf(page2)];
    // Page 1 = ranked(r1,r2,r3) ∪ updatedAt-desc backfill (c4..c10);
    // page 2 = updatedAt-desc MINUS ranked, shifted (c11..c20). Gapless.
    const expected = [
      ...RANKED,
      ...CATALOG.filter((id) => !RANKED.includes(id)).slice(0, 2 * LIMIT - RANKED.length),
    ];
    expect(new Set(union)).toEqual(new Set(expected));
    // Distinct: no id appears twice across the two pages.
    expect(union).toHaveLength(new Set(union).size);
  });

  it("(c) page-2 findMany uses where.id.notIn === rankedIds and skip = offset - rankedIds.length", async () => {
    await call(`game=pokemon&limit=${LIMIT}`);
    prismaMock.card.findMany.mockClear();
    await call(`game=pokemon&limit=${LIMIT}&cursor=${LIMIT}`);

    // Page 2+ is a SINGLE findMany (no ranked/backfill split).
    expect(prismaMock.card.findMany).toHaveBeenCalledTimes(1);
    const args = prismaMock.card.findMany.mock.calls[0][0] as {
      where: { id: { notIn: string[] } };
      skip: number;
      take: number;
      orderBy: unknown;
    };
    expect(args.where.id.notIn).toEqual(RANKED);
    expect(args.skip).toBe(LIMIT - RANKED.length);
    expect(args.take).toBe(LIMIT + 1);
    expect(args.orderBy).toEqual([{ updatedAt: "desc" }]);
  });
});
