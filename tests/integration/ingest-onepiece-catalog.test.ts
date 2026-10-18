import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Full One Piece catalog ingest — mocked (NO network, NO credits).
 *
 * Per-printing re-model (FEAT-002): mapScrydexCatalogCard now returns an ARRAY
 * of rows, one per card.variants[] entry. Covers:
 *   1. A 2-variant card → 2 rows with distinct composite externalIds
 *      (OP08-023 base + OP08-023::alt-art), each with its own printing / imageUrl
 *      / price; the base printing keeps the bare externalId.
 *   2. An imageless non-base variant falls back to the base card art (NOT dropped).
 *   3. A card whose base art is ALSO absent → that printing is dropped (invalid).
 *   4. upsert: game ONE_PIECE on create AND update; composite-keyed; writes this
 *      printing's CurrentPrice rows.
 *   5. Idempotent re-run → "skipped", no second card write.
 *   6. Paging: a mocked 2-page catalog read, pages = ceil(150/100) = 2.
 *
 * The script gates credits only inside run() (never called here), so exercising
 * the pure mapper + the Prisma-mocked upsert needs no credit approval.
 */

const prismaMock = vi.hoisted(() => ({
  cardSet: { upsert: vi.fn() },
  card: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  currentPrice: { deleteMany: vi.fn(), createMany: vi.fn() },
  // The upsert runs this printing's price write as a [deleteMany, createMany]
  // transaction; the mock just resolves the batched operations.
  $transaction: vi.fn((ops: unknown[]) => Promise.resolve(ops)),
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import {
  mapScrydexCatalogCard,
  upsertOnePieceCard,
  type MappedOnePieceCard,
} from "../../scripts/ingest-onepiece-catalog";
import { fetchScrydexCatalogPage, type ScrydexCard } from "@/lib/services/scrydex.service";
import { Game } from "@prisma/client";

// A real-shaped OP08-023 catalog card: REAL Scrydex `images` ARRAY shape — each
// `images` is [{ type:"front", small, medium, large }] (base + each variant),
// the live contract this fix corrects (the old object shape only "worked" in
// the mock). Two variants (normal + alt-art) carry their own front-entry art
// and their own prices.
const OP08_023: ScrydexCard = {
  id: "OP08-023",
  name: "Monkey D. Luffy",
  number: "023",
  rarity: "Super Rare",
  types: ["Red"],
  expansion: { name: "Two Legends" },
  images: [{ type: "front", large: "https://images.scrydex.com/onepiece/OP08-023_large.webp" }],
  variants: [
    {
      name: "normal",
      prices: [{ type: "raw", condition: "NM", market: 12.5, currency: "USD" }],
      images: [{ type: "front", large: "https://images.scrydex.com/onepiece/OP08-023_large.webp" }],
    },
    {
      name: "alt-art",
      prices: [{ type: "raw", condition: "NM", market: 80, currency: "USD" }],
      images: [{ type: "front", large: "https://images.scrydex.com/onepiece/OP08-023_alt_large.webp" }],
    },
  ],
} as unknown as ScrydexCard;

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.cardSet.upsert.mockResolvedValue({ id: "set-internal-1", externalId: "onepiece-two-legends" });
  prismaMock.currentPrice.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.currentPrice.createMany.mockResolvedValue({ count: 1 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mapScrydexCatalogCard (per-printing)", () => {
  it("maps a 2-variant card to 2 rows with distinct composite externalIds", () => {
    const rows = mapScrydexCatalogCard(OP08_023);
    expect(rows).toHaveLength(2);

    const base = rows.find((r) => r.printing === "normal")!;
    const alt = rows.find((r) => r.printing === "alt-art")!;

    // Base printing keeps the bare externalId; number stays the full Bandai code.
    expect(base.externalId).toBe("OP08-023");
    expect(base.number).toBe("OP08-023");
    expect(base.setExternalId).toBe("onepiece-two-legends");
    expect(base.imageUrl).toBe("https://images.scrydex.com/onepiece/OP08-023_large.webp");
    expect(base.marketPrice).toBe(12.5);

    // Non-base printing gets the ${baseId}::${name} composite + its OWN art/price.
    expect(alt.externalId).toBe("OP08-023::alt-art");
    expect(alt.number).toBe("OP08-023");
    expect(alt.imageUrl).toBe("https://images.scrydex.com/onepiece/OP08-023_alt_large.webp");
    expect(alt.marketPrice).toBe(80);

    // Each row carries only its own variant's price rows.
    expect(base.prices).toHaveLength(1);
    expect(base.prices[0].variant).toBe("normal");
    expect(alt.prices[0].variant).toBe("alt-art");
    expect(alt.prices[0].priceMarket).toBe(80);
  });

  it("an imageless non-base variant falls back to base art (NOT dropped)", () => {
    const card = {
      ...OP08_023,
      variants: [
        OP08_023.variants[0],
        { ...OP08_023.variants[1], images: null },
      ],
    } as unknown as ScrydexCard;

    const rows = mapScrydexCatalogCard(card);
    expect(rows).toHaveLength(2);
    const alt = rows.find((r) => r.printing === "alt-art")!;
    // Falls back to the base card art rather than being dropped.
    expect(alt.imageUrl).toBe("https://images.scrydex.com/onepiece/OP08-023_large.webp");
  });

  it("drops a printing whose base art is ALSO absent (invalid)", () => {
    const card = {
      ...OP08_023,
      images: null,
      variants: [
        { ...OP08_023.variants[0] }, // normal keeps its own art → survives
        { ...OP08_023.variants[1], images: null }, // no variant art, no base art → dropped
      ],
    } as unknown as ScrydexCard;

    const rows = mapScrydexCatalogCard(card);
    expect(rows).toHaveLength(1);
    expect(rows[0].printing).toBe("normal");
  });

  it("drops a card with no name (RULE 2 — every row dropped → empty array)", () => {
    const bad = { ...OP08_023, name: "" } as unknown as ScrydexCard;
    expect(mapScrydexCatalogCard(bad)).toEqual([]);
  });

  it("drops a card with no set name → empty array", () => {
    const bad = { ...OP08_023, expansion: { name: "" } } as unknown as ScrydexCard;
    expect(mapScrydexCatalogCard(bad)).toEqual([]);
  });
});

describe("upsertOnePieceCard (per-printing)", () => {
  it("creates a new printing row with game ONE_PIECE, composite key, and price rows", async () => {
    prismaMock.card.findUnique.mockResolvedValue(null);
    prismaMock.card.create.mockResolvedValue({ id: "card-internal-1" });
    const [base] = mapScrydexCatalogCard(OP08_023);

    const result = await upsertOnePieceCard(base);

    expect(result).toBe("created");
    expect(prismaMock.cardSet.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { externalId: "onepiece-two-legends" } })
    );
    const data = prismaMock.card.create.mock.calls[0][0].data;
    expect(data.externalId).toBe("OP08-023");
    expect(data.number).toBe("OP08-023");
    expect(data.printing).toBe("normal");
    expect(data.game).toBe(Game.ONE_PIECE);
    expect(data.setId).toBe("set-internal-1");
    // This printing's price rows are replaced: delete this variant's SCRYDEX
    // rows, then createMany the fresh set (this variant only).
    expect(prismaMock.currentPrice.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ cardId: "card-internal-1", variant: "normal" }) })
    );
    const createArg = prismaMock.currentPrice.createMany.mock.calls[0][0];
    expect(createArg.data[0].cardId).toBe("card-internal-1");
    expect(createArg.data[0].variant).toBe("normal");
  });

  it("creates the non-base printing under its composite externalId", async () => {
    prismaMock.card.findUnique.mockResolvedValue(null);
    prismaMock.card.create.mockResolvedValue({ id: "card-internal-2" });
    const alt = mapScrydexCatalogCard(OP08_023).find((r) => r.printing === "alt-art")!;

    const result = await upsertOnePieceCard(alt);

    expect(result).toBe("created");
    expect(prismaMock.card.create.mock.calls[0][0].data.externalId).toBe("OP08-023::alt-art");
    expect(prismaMock.card.create.mock.calls[0][0].data.printing).toBe("alt-art");
  });

  it("is idempotent: an identical prior row → skipped, no card update written", async () => {
    const [base] = mapScrydexCatalogCard(OP08_023);
    prismaMock.card.findUnique.mockResolvedValue({
      id: "card-internal-1",
      name: base.name,
      number: base.number,
      printing: base.printing,
      rarity: base.rarity,
      types: base.types,
      imageUrl: base.imageUrl,
      marketPrice: base.marketPrice,
      setId: "set-internal-1",
    });

    const result = await upsertOnePieceCard(base);

    expect(result).toBe("skipped");
    expect(prismaMock.card.create).not.toHaveBeenCalled();
    expect(prismaMock.card.update).not.toHaveBeenCalled();
  });

  it("updates when a mapped field differs (game ONE_PIECE set on update too)", async () => {
    const [base] = mapScrydexCatalogCard(OP08_023);
    prismaMock.card.findUnique.mockResolvedValue({
      id: "card-internal-1",
      name: "Old Name", // differs → update
      number: base.number,
      printing: base.printing,
      rarity: base.rarity,
      types: base.types,
      imageUrl: base.imageUrl,
      marketPrice: base.marketPrice,
      setId: "set-internal-1",
    });

    const result = await upsertOnePieceCard(base);

    expect(result).toBe("updated");
    expect(prismaMock.card.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.card.update.mock.calls[0][0].data.game).toBe(Game.ONE_PIECE);
  });
});

describe("fetchScrydexCatalogPage (mocked fetch — paging + total_count)", () => {
  it("parses two pages and total_count drives pages = ceil(150/100) = 2", async () => {
    const SECOND: ScrydexCard = { ...OP08_023, id: "OP08-024", name: "Roronoa Zoro" };
    const fetchMock = vi.fn(
      (url: string): Promise<Response> => {
        const page = url.includes("page=2") ? 2 : 1;
        const body =
          page === 1
            ? { data: [OP08_023], total_count: 150, page_size: 100 }
            : { data: [SECOND], total_count: 150, page_size: 100 };
        return Promise.resolve(
          new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
        );
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    // scrydexHeaders() needs these present (never sent — fetch is mocked).
    vi.stubEnv("SCRYDEX_API_KEY", "test-key");
    vi.stubEnv("SCRYDEX_TEAM_ID", "test-team");

    const p1 = await fetchScrydexCatalogPage(Game.ONE_PIECE, 1, 100);
    const p2 = await fetchScrydexCatalogPage(Game.ONE_PIECE, 2, 100);

    expect(p1?.totalCount).toBe(150);
    expect(p1?.cards[0].id).toBe("OP08-023");
    expect(p2?.cards[0].id).toBe("OP08-024");
    const pages = Math.ceil((p1?.totalCount ?? 0) / 100);
    expect(pages).toBe(2);
  });
});

// Keep the MappedOnePieceCard type referenced so the import is exercised.
void (null as unknown as MappedOnePieceCard);
