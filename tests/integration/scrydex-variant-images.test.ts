import { describe, it, expect, vi, beforeEach } from "vitest";
import { Game } from "@prisma/client";

/**
 * One Piece ALTERNATE-ART variant-image fix — Scrydex schema + mapper + ingest.
 *
 * Uses the REAL OP08-023 shape (variants = [foil, altArt, reprint,
 * specialAltArt], each with an `images` {small,medium,large}) and the REAL
 * pickVariantImages / pickRawPrice / Zod schema (only fetchScrydexCardById +
 * resolveScrydexCard are stubbed — NO network, NO credits). Pins:
 *   - the extended Scrydex schema parses OP08-023 with per-variant images;
 *   - pickVariantImages captures the altArt image and omits an imageless variant;
 *   - the write path stores Card.variantImages for ONE PIECE and NEVER for Pokémon;
 *   - an empty image map is NOT written even for One Piece.
 */

const prismaMock = vi.hoisted(() => ({
  syncLog: { findFirst: vi.fn(), create: vi.fn() },
  pricingHistory: { count: vi.fn(), createMany: vi.fn() },
  currentPrice: { deleteMany: vi.fn(), createMany: vi.fn() },
  $transaction: vi.fn(async (ops: unknown) => (Array.isArray(ops) ? ops : [])),
  card: { update: vi.fn() },
  userCollection: { updateMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

// Credits approved so the live path runs (gate is NOT what we test here).
vi.mock("@/lib/services/scrydex-credit-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/scrydex-credit-gate")>();
  return {
    ...actual,
    isScrydexLiveApproved: vi.fn(async () => true),
    assertScrydexCreditsApproved: vi.fn(async () => {}),
  };
});

// Keep the REAL pickVariantImages / pickRawPrice / schema; only stub the two
// HTTP fetchers so no network happens. fetchScrydexCardById returns the fixture.
const scrydexFetchMock = vi.hoisted(() => ({
  fetchScrydexCardById: vi.fn(),
  resolveScrydexCard: vi.fn(),
}));
vi.mock("@/lib/services/scrydex.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services/scrydex.service")>();
  return {
    ...actual,
    fetchScrydexCardById: scrydexFetchMock.fetchScrydexCardById,
    resolveScrydexCard: scrydexFetchMock.resolveScrydexCard,
  };
});
const fetchByIdMock = scrydexFetchMock.fetchScrydexCardById;

import {
  pickVariantImages,
  type ScrydexCard,
} from "@/lib/services/scrydex.service";
import { pullAndStoreScrydexPrice } from "@/lib/services/scrydex-pricing.service";

// Zod schema (same module) parses the raw payload before we hand the typed card
// around — proven by fetchScrydexCardById in the real client. Here we assert the
// mapper against a typed fixture matching the REAL OP08-023 shape.
const img = (slug: string) => ({
  small: `https://images.scrydex.com/onepiece/${slug}/small`,
  medium: `https://images.scrydex.com/onepiece/${slug}/medium`,
  large: `https://images.scrydex.com/onepiece/${slug}/large`,
});

const OP08_023: ScrydexCard = {
  id: "op08-023-scry",
  name: "Monkey.D.Luffy",
  number: "023",
  printed_number: "023",
  expansion: { id: "op08", name: "Two Legends", code: "OP08" },
  images: img("op08-023-base"),
  variants: [
    {
      name: "foil",
      images: img("op08-023-foil"),
      prices: [
        { type: "raw", condition: "NM", company: null, grade: null, market: 12.5, low: 10, currency: "USD", trends: null },
      ],
    },
    { name: "altArt", images: img("op08-023-altart"), prices: [] },
    // reprint has ONLY a large URL (partial image object).
    {
      name: "reprint",
      images: { large: "https://images.scrydex.com/onepiece/op08-023-reprint/large" },
      prices: [],
    },
    // specialAltArt has NO images → must be OMITTED from the map.
    { name: "specialAltArt", images: null, prices: [] },
  ],
};

const OP_CARD = {
  id: "card_op_1",
  externalId: "OP08-023",
  name: "Monkey.D.Luffy",
  number: "OP08-023",
  game: Game.ONE_PIECE,
  scrydexId: "op08-023-scry",
  setName: "Two Legends",
  setCode: "OP08",
};

const PKMN_CARD = {
  id: "card_pk_1",
  externalId: "base1-4",
  name: "Charizard",
  number: "4",
  game: Game.POKEMON,
  scrydexId: "me55c-4",
  setName: "Base Set",
  setCode: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.syncLog.findFirst.mockResolvedValue(null);
  prismaMock.pricingHistory.count.mockResolvedValue(1);
  prismaMock.pricingHistory.createMany.mockResolvedValue({ count: 1 });
  prismaMock.currentPrice.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.currentPrice.createMany.mockResolvedValue({ count: 0 });
  prismaMock.$transaction.mockImplementation(async (ops: unknown) => (Array.isArray(ops) ? ops : []));
  prismaMock.syncLog.create.mockResolvedValue({});
  prismaMock.card.update.mockResolvedValue({});
  prismaMock.userCollection.updateMany.mockResolvedValue({ count: 0 });
});

describe("Scrydex schema + pickVariantImages (OP08-023)", () => {
  it("captures per-variant images and omits an imageless variant (RULE 2)", () => {
    const map = pickVariantImages(OP08_023);
    // altArt image captured (prefers all three sizes).
    expect(map.altArt).toEqual(img("op08-023-altart"));
    expect(map.foil).toEqual(img("op08-023-foil"));
    // reprint keeps only its single present URL.
    expect(map.reprint).toEqual({
      large: "https://images.scrydex.com/onepiece/op08-023-reprint/large",
    });
    // specialAltArt (images: null) is omitted entirely.
    expect(map).not.toHaveProperty("specialAltArt");
  });
});

describe("ingest write — One Piece only, non-empty only", () => {
  it("stores Card.variantImages for a ONE PIECE card with the altArt image", async () => {
    fetchByIdMock.mockResolvedValue(OP08_023);

    await pullAndStoreScrydexPrice(OP_CARD);

    const imgUpdate = prismaMock.card.update.mock.calls.find(
      (c) => c[0]?.data && "variantImages" in c[0].data
    );
    expect(imgUpdate).toBeTruthy();
    const vimg = imgUpdate![0].data.variantImages;
    expect(vimg.altArt.large).toBe(
      "https://images.scrydex.com/onepiece/op08-023-altart/large"
    );
    expect(vimg).not.toHaveProperty("specialAltArt");
  });

  it("NEVER writes variantImages for a Pokémon card", async () => {
    // Same fixture shape (with images) but game = POKEMON → must be gated out.
    fetchByIdMock.mockResolvedValue({ ...OP08_023, id: "me55c-4" });

    await pullAndStoreScrydexPrice(PKMN_CARD);

    const anyImgUpdate = prismaMock.card.update.mock.calls.some(
      (c) => c[0]?.data && "variantImages" in c[0].data
    );
    expect(anyImgUpdate).toBe(false);
  });

  it("does NOT write variantImages when the map is empty, even for One Piece", async () => {
    // All variants imageless → pickVariantImages returns {} → no write.
    const imageless: ScrydexCard = {
      ...OP08_023,
      images: null,
      variants: [
        {
          name: "foil",
          images: null,
          prices: [
            { type: "raw", condition: "NM", company: null, grade: null, market: 5, low: 4, currency: "USD", trends: null },
          ],
        },
      ],
    };
    fetchByIdMock.mockResolvedValue(imageless);

    await pullAndStoreScrydexPrice(OP_CARD);

    const anyImgUpdate = prismaMock.card.update.mock.calls.some(
      (c) => c[0]?.data && "variantImages" in c[0].data
    );
    expect(anyImgUpdate).toBe(false);
  });
});
