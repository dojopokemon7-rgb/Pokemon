import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Full One Piece catalog ingest — mocked (NO network, NO credits).
 *
 * Covers the four behaviors the script must guarantee:
 *   1. Mapping + upsert: a card maps to externalId = Bandai code, number = full
 *      Bandai code, game ONE_PIECE on create, the correct onepiece-<slug> set,
 *      and both variants' images (incl. alt-art) in variantImages → "created".
 *   2. Idempotent re-run: an identical prior row → "skipped", no second write.
 *   3. Invalid card dropped: a card with no name maps to null (RULE 2 drop).
 *   4. Paging: a mocked 2-page catalog read via fetchScrydexCatalogPage, and
 *      pages = ceil(total_count / 100) = 2 — WITHOUT touching the real API.
 *
 * The script gates credits only inside run() (never called here), so exercising
 * the pure mapper + the Prisma-mocked upsert needs no credit approval.
 */

const prismaMock = vi.hoisted(() => ({
  cardSet: { upsert: vi.fn() },
  card: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
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
// the mock). Two variants (normal + alt-art) carry their own front-entry art.
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
      prices: [{ type: "raw", market: 12.5, currency: "USD" }],
      images: [{ type: "front", large: "https://images.scrydex.com/onepiece/OP08-023_large.webp" }],
    },
    {
      name: "alt-art",
      prices: [],
      images: [{ type: "front", large: "https://images.scrydex.com/onepiece/OP08-023_alt_large.webp" }],
    },
  ],
} as unknown as ScrydexCard;

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.cardSet.upsert.mockResolvedValue({ id: "set-internal-1", externalId: "onepiece-two-legends" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mapScrydexCatalogCard", () => {
  it("maps externalId/number (full Bandai code), set key, and both variant images", () => {
    const m = mapScrydexCatalogCard(OP08_023)!;
    expect(m).not.toBeNull();
    expect(m.externalId).toBe("OP08-023");
    expect(m.number).toBe("OP08-023"); // full Bandai code
    expect(m.setExternalId).toBe("onepiece-two-legends");
    expect(m.imageUrl).toBe("https://images.scrydex.com/onepiece/OP08-023_large.webp");
    expect(m.marketPrice).toBe(12.5);
    expect(Object.keys(m.variantImages).sort()).toEqual(["alt-art", "normal"]);
    expect(m.variantImages["alt-art"].large).toBe(
      "https://images.scrydex.com/onepiece/OP08-023_alt_large.webp"
    );
  });

  it("drops a card with no name (RULE 2 — returns null, never fabricated)", () => {
    const bad = { ...OP08_023, name: "" } as unknown as ScrydexCard;
    expect(mapScrydexCatalogCard(bad)).toBeNull();
  });

  it("drops a card with no usable image (imageUrl fails the normalized validator)", () => {
    const noImg = {
      ...OP08_023,
      images: null,
      variants: OP08_023.variants.map((v) => ({ ...v, images: null })),
    } as unknown as ScrydexCard;
    expect(mapScrydexCatalogCard(noImg)).toBeNull();
  });
});

describe("upsertOnePieceCard", () => {
  it("creates a new card with game ONE_PIECE and the correct set scope", async () => {
    prismaMock.card.findUnique.mockResolvedValue(null);
    const m = mapScrydexCatalogCard(OP08_023)!;

    const result = await upsertOnePieceCard(m);

    expect(result).toBe("created");
    expect(prismaMock.cardSet.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { externalId: "onepiece-two-legends" } })
    );
    expect(prismaMock.card.create).toHaveBeenCalledTimes(1);
    const data = prismaMock.card.create.mock.calls[0][0].data;
    expect(data.externalId).toBe("OP08-023");
    expect(data.number).toBe("OP08-023");
    expect(data.game).toBe(Game.ONE_PIECE);
    expect(data.setId).toBe("set-internal-1");
    expect(Object.keys(data.variantImages).sort()).toEqual(["alt-art", "normal"]);
  });

  it("is idempotent: an identical prior row → skipped, no update written", async () => {
    const m = mapScrydexCatalogCard(OP08_023)!;
    prismaMock.card.findUnique.mockResolvedValue({
      id: "card-internal-1",
      name: m.name,
      number: m.number,
      rarity: m.rarity,
      types: m.types,
      imageUrl: m.imageUrl,
      marketPrice: m.marketPrice,
      variantImages: m.variantImages,
      setId: "set-internal-1",
    });

    const result = await upsertOnePieceCard(m);

    expect(result).toBe("skipped");
    expect(prismaMock.card.create).not.toHaveBeenCalled();
    expect(prismaMock.card.update).not.toHaveBeenCalled();
  });

  it("updates when a mapped field differs (game ONE_PIECE set on update too)", async () => {
    const m = mapScrydexCatalogCard(OP08_023)!;
    prismaMock.card.findUnique.mockResolvedValue({
      id: "card-internal-1",
      name: "Old Name", // differs → update
      number: m.number,
      rarity: m.rarity,
      types: m.types,
      imageUrl: m.imageUrl,
      marketPrice: m.marketPrice,
      variantImages: m.variantImages,
      setId: "set-internal-1",
    });

    const result = await upsertOnePieceCard(m);

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
