import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * FEAT-004 — per-printing catalog PARITY at the UI read/write boundaries.
 * Everything external is MOCKED (Prisma + cache); no live DB / network / Scrydex
 * credits. Pins the acceptance criteria that depend on each printing being its
 * OWN Card row:
 *
 *   - AC-15/16/17: GET /api/cards/search returns N separate results for N
 *     per-printing rows of one number, each carrying its OWN printing label,
 *     price and image (no collapse to one headline).
 *   - AC-18: GET /api/cards/filter-options still returns the SAME distinct
 *     set-name / rarity semantics after per-printing rows are seeded (per-
 *     printing rows do not multiply options — sets + rarities are de-duped).
 *   - AC-19: adding two distinct printings of one number yields TWO
 *     UserCollection rows (distinct cardId); a repeat add of one printing
 *     increments quantity (uc_variant_coalesced not weakened).
 *   - MEDIUM-2 / §6.3: the new-card number fallback is composite-safe —
 *     "OP01-120::alt-art" -> number "OP01-120"; "base1-4::reverse holofoil"
 *     -> number "4" (strips the ::<variant> suffix before deriving).
 */

// ---------------------------------------------------------------- search + filter-options
const prismaMock = vi.hoisted(() => ({
  card: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  cardSet: { findMany: vi.fn(), upsert: vi.fn() },
  collection: { findMany: vi.fn(), create: vi.fn() },
  userCollection: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  pricingHistory: { createMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const cacheMock = vi.hoisted(() => ({
  cacheGetJson: vi.fn(async (): Promise<unknown> => null),
  cacheSetJson: vi.fn(async () => undefined),
  invalidateUserCaches: vi.fn(async () => undefined),
}));
vi.mock("@/lib/utils/cache", () => cacheMock);

const indexMock = vi.hoisted(() => ({
  isSearchIndexEnabled: vi.fn(() => false),
  searchIndexIds: vi.fn(async (): Promise<string[] | null> => null),
}));
vi.mock("@/lib/services/card-search-index.service", () => indexMock);

const USER_ID = "user_pp";
vi.mock("@/lib/utils/auth-guard", () => ({
  requireAuth: vi.fn(async () => ({ unauthorized: null, session: { user: { id: USER_ID } } })),
}));
// /api/cards/search best-effort resolves a session for rate-limit keying.
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: vi.fn(async () => null) } } }));

import { GET as searchGET } from "@/app/api/cards/search/route";
import { GET as filterOptionsGET } from "@/app/api/cards/filter-options/route";
import { POST as collectionAddPOST } from "@/app/api/users/me/collection/route";

/** A per-printing Card row as the search route selects it. */
const printingRow = (
  externalId: string,
  printing: string,
  imageUrl: string,
  priceMarket: number
) => ({
  externalId,
  name: "Shanks",
  number: "OP01-120",
  printing,
  rarity: "Leader",
  types: [],
  tags: [],
  imageUrl,
  imageUrlHi: null,
  marketPrice: priceMarket,
  // Each printing row holds ONLY its own variant's CurrentPrice rows, so
  // pickHeadlineRaw returns THIS printing's price (AC-17).
  currentPrices: [
    { variant: printing, type: "raw", condition: "NM", company: null, grade: null, priceMarket, priceLow: null },
  ],
  set: { name: "Romance Dawn" },
});

beforeEach(() => {
  vi.clearAllMocks();
  cacheMock.cacheGetJson.mockResolvedValue(null);
  indexMock.isSearchIndexEnabled.mockReturnValue(false);
});

describe("GET /api/cards/search — per-printing parity (AC-15/16/17)", () => {
  it("returns one result PER printing, each with its own label, price and image", async () => {
    const rows = [
      printingRow("OP01-120", "normal", "/api/one-piece-img/OP01-120", 5),
      printingRow("OP01-120::alt-art", "alt-art", "https://images.scrydex.com/op/alt/large", 42),
      printingRow("OP01-120::foil", "foil", "https://images.scrydex.com/op/foil/large", 18),
    ];
    prismaMock.card.findMany.mockResolvedValue(rows);

    const res = await searchGET(
      new Request("http://localhost/api/cards/search?game=onepiece&query=shanks")
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // Three distinct results (one per printing), not one collapsed headline.
    expect(body.cards).toHaveLength(3);
    const byId = Object.fromEntries(
      body.cards.map((c: { id: string }) => [c.id, c])
    ) as Record<string, { id: string; printing: string | null; marketPrice: number | null; imageUrl: string }>;

    // Distinct printing labels surfaced on the envelope.
    expect(byId["OP01-120"].printing).toBe("normal");
    expect(byId["OP01-120::alt-art"].printing).toBe("alt-art");
    expect(byId["OP01-120::foil"].printing).toBe("foil");

    // Distinct per-printing prices (AC-17 — never a shared headline).
    expect(byId["OP01-120"].marketPrice).toBe(5);
    expect(byId["OP01-120::alt-art"].marketPrice).toBe(42);
    expect(byId["OP01-120::foil"].marketPrice).toBe(18);

    // Distinct per-printing images.
    const images = new Set(body.cards.map((c: { imageUrl: string }) => c.imageUrl));
    expect(images.size).toBe(3);

    // The select pulls the printing column.
    expect(prismaMock.card.findMany.mock.calls[0][0].select.printing).toBe(true);
  });

  it("surfaces printing: null for a row with no stored printing (old blob / additive schema)", async () => {
    // name + number match the query so the relevance ranker keeps the row.
    const legacy = {
      ...printingRow("sv3-1", "normal", "https://x/i", 1),
      name: "Pikachu",
      number: "1",
      printing: null,
    };
    prismaMock.card.findMany.mockResolvedValue([legacy]);

    const res = await searchGET(
      new Request("http://localhost/api/cards/search?game=pokemon&query=pikachu")
    );
    const body = await res.json();
    expect(body.cards[0].printing).toBeNull();
  });
});

describe("GET /api/cards/filter-options — unaffected by per-printing rows (AC-18)", () => {
  it("returns the SAME distinct set-name / rarity set after seeding per-printing rows", async () => {
    // Three per-printing rows of ONE number all share ONE set + ONE rarity;
    // the distinct option lists must therefore NOT multiply.
    prismaMock.cardSet.findMany.mockResolvedValue([{ name: "Romance Dawn" }]);
    prismaMock.card.findMany.mockResolvedValue([{ rarity: "Leader" }]); // distinct:["rarity"] collapses the 3 rows

    const res = await filterOptionsGET(
      new Request("http://localhost/api/cards/filter-options?game=onepiece")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sets).toEqual(["Romance Dawn"]);
    expect(body.rarities).toEqual(["Leader"]);

    // The rarity query asks Prisma for DISTINCT rarities (the collapse point).
    expect(prismaMock.card.findMany.mock.calls[0][0].distinct).toEqual(["rarity"]);
  });
});

// ---------------------------------------------------------------- add-to-collection
const MAIN = { id: "col_main", name: "Main" };

function addBody(cards: unknown[]) {
  return new Request("http://localhost/api/users/me/collection", {
    method: "POST",
    body: JSON.stringify({ cards }),
  });
}

describe("POST /api/users/me/collection — per-printing lots (AC-19)", () => {
  beforeEach(() => {
    prismaMock.cardSet.upsert.mockResolvedValue({ id: "set_1" });
    prismaMock.pricingHistory.createMany.mockResolvedValue({});
    // No collectionId in the body → the route resolves the user's Main via
    // getOrCreateMainCollection (prisma.collection.findMany).
    prismaMock.collection.findMany.mockResolvedValue([MAIN]);
  });

  it("adds two DISTINCT printings of one number as two UserCollection rows", async () => {
    // Each printing is its OWN Card row (distinct cardId) — so each add makes a
    // distinct UserCollection row. No existing lots for either.
    prismaMock.card.findFirst
      .mockResolvedValueOnce({ id: "card_alt", externalId: "OP01-120::alt-art", marketPrice: 40 })
      .mockResolvedValueOnce({ id: "card_foil", externalId: "OP01-120::foil", marketPrice: 15 });
    prismaMock.userCollection.findMany.mockResolvedValue([]);
    prismaMock.userCollection.create.mockResolvedValue({ id: "uc" });

    const res = await collectionAddPOST(
      addBody([
        { externalId: "OP01-120::alt-art", name: "Shanks", quantity: 1 },
        { externalId: "OP01-120::foil", name: "Shanks", quantity: 1 },
      ])
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.added).toBe(2);
    expect(prismaMock.userCollection.create).toHaveBeenCalledTimes(2);
    const cardIds = prismaMock.userCollection.create.mock.calls.map((c) => c[0].data.cardId);
    expect(new Set(cardIds)).toEqual(new Set(["card_alt", "card_foil"]));
  });

  it("a repeat add of ONE printing increments quantity (uc_variant_coalesced unchanged)", async () => {
    prismaMock.card.findFirst.mockResolvedValue({
      id: "card_alt",
      externalId: "OP01-120::alt-art",
      marketPrice: 40,
    });
    // An existing active lot of this exact printing + condition is found.
    prismaMock.userCollection.findMany.mockResolvedValue([
      { id: "uc_existing", condition: null, quantity: 1 },
    ]);
    prismaMock.userCollection.update.mockResolvedValue({ id: "uc_existing", quantity: 3 });

    const res = await collectionAddPOST(
      addBody([{ externalId: "OP01-120::alt-art", name: "Shanks", quantity: 2 }])
    );

    expect((await res.json()).added).toBe(1);
    expect(prismaMock.userCollection.create).not.toHaveBeenCalled();
    expect(prismaMock.userCollection.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.userCollection.update.mock.calls[0][0].data.quantity).toBe(3); // 1 + 2
  });
});

describe("POST /api/users/me/collection — composite-safe number fallback (MEDIUM-2 / §6.3)", () => {
  beforeEach(() => {
    prismaMock.cardSet.upsert.mockResolvedValue({ id: "set_1" });
    prismaMock.userCollection.findMany.mockResolvedValue([]);
    prismaMock.userCollection.create.mockResolvedValue({ id: "uc" });
    prismaMock.pricingHistory.createMany.mockResolvedValue({});
    prismaMock.collection.findMany.mockResolvedValue([MAIN]);
  });

  it("derives number 'OP01-120' from the composite id 'OP01-120::alt-art' (One Piece)", async () => {
    // No catalog row for this composite id → the create fallback runs.
    prismaMock.card.findFirst.mockResolvedValue(null);
    prismaMock.card.create.mockResolvedValue({ id: "card_new", externalId: "OP01-120::alt-art", marketPrice: null });

    const res = await collectionAddPOST(
      addBody([{ externalId: "OP01-120::alt-art", name: "Shanks", quantity: 1 }])
    );
    expect((await res.json()).added).toBe(1);

    const created = prismaMock.card.create.mock.calls[0][0].data;
    expect(created.externalId).toBe("OP01-120::alt-art"); // full composite id kept as identity
    expect(created.number).toBe("OP01-120"); // number is the BASE code, not the composite
  });

  it("derives number '4' from the composite id 'base1-4::reverse holofoil' (Pokémon)", async () => {
    prismaMock.card.findFirst.mockResolvedValue(null);
    prismaMock.card.create.mockResolvedValue({ id: "card_new", externalId: "base1-4::reverse holofoil", marketPrice: null });

    const res = await collectionAddPOST(
      addBody([{ externalId: "base1-4::reverse holofoil", name: "Charizard", quantity: 1 }])
    );
    expect((await res.json()).added).toBe(1);

    const created = prismaMock.card.create.mock.calls[0][0].data;
    expect(created.externalId).toBe("base1-4::reverse holofoil");
    expect(created.number).toBe("4"); // hyphen-tail of the BASE id, suffix stripped
  });

  it("is a no-op for a non-composite id ('base1-4' -> number '4')", async () => {
    prismaMock.card.findFirst.mockResolvedValue(null);
    prismaMock.card.create.mockResolvedValue({ id: "card_new", externalId: "base1-4", marketPrice: null });

    await collectionAddPOST(addBody([{ externalId: "base1-4", name: "Charizard", quantity: 1 }]));

    expect(prismaMock.card.create.mock.calls[0][0].data.number).toBe("4");
  });
});
