import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Audit 02 F-T — offset pagination on /api/cards/search.
 *
 * The BROWSE branch (empty query + a filter, e.g. ?set=Base) and the
 * EXPLICIT-SORT branch are DB-paginated via `skip: cursor` + `take: PAGE+1`,
 * mirroring /api/cards/trending. These tests mock Prisma so the only thing
 * under test is the route's paging arithmetic: exact page size, the
 * `skip`/`take` threaded into findMany, a non-null numeric `nextCursor` when a
 * further page exists, no overlap between consecutive pages, and `nextCursor`
 * null on the final page.
 */

const prismaMock = vi.hoisted(() => ({ card: { findMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const cacheMock = vi.hoisted(() => ({
  cacheGetJson: vi.fn(async (_k: string): Promise<unknown> => null),
  cacheSetJson: vi.fn(async (..._a: unknown[]) => undefined),
}));
vi.mock("@/lib/utils/cache", () => cacheMock);

vi.mock("@/lib/services/card-search-index.service", () => ({
  isSearchIndexEnabled: vi.fn(() => false),
  searchIndexIds: vi.fn(async () => null),
}));

import { GET } from "@/app/api/cards/search/route";

const PAGE = 60;

const row = (externalId: string) => ({
  externalId,
  name: externalId,
  number: "1",
  rarity: "Rare",
  types: [],
  tags: [],
  imageUrl: "u",
  imageUrlHi: null,
  marketPrice: 1,
  weeklyChangePct: null,
  currentPrices: [],
  set: { name: "Base" },
});

// A page of n distinct rows with ids offset-<n>.
const pageOf = (start: number, n: number) =>
  Array.from({ length: n }, (_, i) => row(`id-${start + i}`));

const call = (qs: string) => GET(new Request(`http://localhost/api/cards/search?${qs}`));
const lastFindArgs = () =>
  prismaMock.card.findMany.mock.calls.at(-1)![0] as {
    skip: number;
    take: number;
    orderBy: unknown;
  };

beforeEach(() => {
  vi.clearAllMocks();
  cacheMock.cacheGetJson.mockResolvedValue(null);
});

describe("GET /api/cards/search — browse pagination (?set=Base)", () => {
  it("cursor=0 → PAGE items + non-null numeric nextCursor; findMany skip:0 take:PAGE+1", async () => {
    // One extra row signals a further page exists.
    prismaMock.card.findMany.mockResolvedValue(pageOf(0, PAGE + 1));
    const res = await call("game=pokemon&set=Base");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cards).toHaveLength(PAGE);
    expect(body.nextCursor).toBe(PAGE);
    const args = lastFindArgs();
    expect(args.skip).toBe(0);
    expect(args.take).toBe(PAGE + 1);
  });

  it("cursor=PAGE → the NEXT distinct page (no overlap, no gap), same ordering, skip:PAGE", async () => {
    // Page 1 ids: id-0..id-59. Page 2 ids: id-60..id-119 (contiguous, distinct).
    prismaMock.card.findMany.mockResolvedValueOnce(pageOf(0, PAGE + 1));
    const page1 = await (await call("game=pokemon&set=Base")).json();

    prismaMock.card.findMany.mockResolvedValueOnce(pageOf(PAGE, PAGE + 1));
    const page2 = await (await call(`game=pokemon&set=Base&cursor=${PAGE}`)).json();

    const ids1 = page1.cards.map((c: { id: string }) => c.id);
    const ids2 = page2.cards.map((c: { id: string }) => c.id);
    // No overlap between consecutive pages.
    expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
    // No gap: page 2 starts exactly where page 1 ended.
    expect(ids1.at(-1)).toBe(`id-${PAGE - 1}`);
    expect(ids2[0]).toBe(`id-${PAGE}`);

    const args = lastFindArgs();
    expect(args.skip).toBe(PAGE);
    expect(args.take).toBe(PAGE + 1);
    // Ordering is unchanged (marketPrice desc, externalId asc).
    expect(args.orderBy).toEqual([
      { marketPrice: { sort: "desc", nulls: "last" } },
      { externalId: "asc" },
    ]);
    expect(page2.nextCursor).toBe(PAGE * 2);
  });

  it("final page (< PAGE+1 rows) → nextCursor null", async () => {
    prismaMock.card.findMany.mockResolvedValue(pageOf(0, 10));
    const body = await (await call("game=pokemon&set=Base")).json();
    expect(body.cards).toHaveLength(10);
    expect(body.nextCursor).toBeNull();
  });
});

describe("GET /api/cards/search — explicit-sort pagination", () => {
  it("threads skip/take and computes nextCursor for an explicit sort", async () => {
    prismaMock.card.findMany.mockResolvedValue(pageOf(0, PAGE + 1));
    const body = await (await call(`game=pokemon&set=Base&sort=market_desc&cursor=${PAGE}`)).json();
    // Explicit sort is a SINGLE DB query (relevance ranking is skipped).
    expect(prismaMock.card.findMany).toHaveBeenCalledTimes(1);
    const args = lastFindArgs();
    expect(args.skip).toBe(PAGE);
    expect(args.take).toBe(PAGE + 1);
    expect(body.cards).toHaveLength(PAGE);
    expect(body.nextCursor).toBe(PAGE * 2);
  });
});
