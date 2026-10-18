import { describe, it, expect } from "vitest";
import { Game, DataSource } from "@prisma/client";
import {
  buildCardRows,
  buildPriceRows,
  pickBaseImageUrl,
} from "../../scripts/pull-full-catalog";

/**
 * Pokemon per-printing mapper (FEAT-002, NIT-4) — PURE seam, no live runner.
 *
 * buildCardRows emits ONE row per c.variants[] entry: composite externalId (base
 * keeps the bare Scrydex id, non-base = `${baseId}::${name}`), each row carries
 * its own printing / imageUrl and a HEADLINE price from ITS OWN variant (never
 * variant-0, never the catalog-wide flatMap union). An imageless variant falls
 * back to the base c.images art; a base card with no image at all drops to a
 * null imageUrl.
 */

// A 3-variant Scrydex-shaped Pokemon card. Each variant carries a DISTINCT
// NM-raw market price, so copying variant-0's price onto every row would be
// visible (and fail AC-17).
const CARD = {
  id: "sv1-25",
  name: "Pikachu",
  number: "25",
  rarity: "Common",
  types: ["Lightning"],
  images: [{ type: "front", medium: "https://img/sv1-25.png", large: "https://img/sv1-25_hi.png" }],
  expansion: { id: "sv1", name: "Scarlet & Violet" },
  variants: [
    {
      name: "normal",
      images: [{ type: "front", medium: "https://img/sv1-25_normal.png", large: "https://img/sv1-25_normal_hi.png" }],
      prices: [
        {
          type: "raw", condition: "NM", market: 1.5, low: 1, currency: "USD",
          trends: { days_7: { price_change: 0.1, percent_change: 7 } },
        },
      ],
    },
    {
      name: "reverse holofoil",
      images: [{ type: "front", medium: "https://img/sv1-25_rev.png", large: "https://img/sv1-25_rev_hi.png" }],
      prices: [
        {
          type: "raw", condition: "NM", market: 4.25, low: 3, currency: "USD",
          trends: { days_7: { price_change: -0.2, percent_change: -4 } },
        },
      ],
    },
    {
      // No variant art → must fall back to the base c.images front entry.
      name: "holofoil",
      images: null,
      prices: [
        {
          type: "raw", condition: "NM", market: 9.99, low: 8, currency: "USD",
          trends: { days_7: { price_change: 0.5, percent_change: 5 } },
        },
      ],
    },
  ],
};

describe("buildCardRows (Pokemon per-printing)", () => {
  it("emits one row per variant with distinct composite externalIds + per-variant headline price", () => {
     
    const rows = buildCardRows(CARD as any, "set-db-1", Game.POKEMON, CARD.id);
    expect(rows).toHaveLength(3);

    const normal = rows.find((r) => r.printing === "normal")!;
    const rev = rows.find((r) => r.printing === "reverse holofoil")!;
    const holo = rows.find((r) => r.printing === "holofoil")!;

    // Base printing keeps the bare id; non-base gets the composite key.
    expect(normal.externalId).toBe("sv1-25");
    expect(rev.externalId).toBe("sv1-25::reverse holofoil");
    expect(holo.externalId).toBe("sv1-25::holofoil");

    // scrydexId stays c.id (now non-unique) on every row; number unchanged.
    expect(rows.every((r) => r.scrydexId === "sv1-25")).toBe(true);
    expect(rows.every((r) => r.number === "25")).toBe(true);

    // Headline price comes from EACH variant, not variant-0.
    expect(normal.marketPrice).toBe(1.5);
    expect(rev.marketPrice).toBe(4.25);
    expect(holo.marketPrice).toBe(9.99);
    // Weekly change rides the SAME variant's trends.days_7.
    expect(rev.weeklyChangeAbs).toBe(-0.2);
    expect(rev.weeklyChangePct).toBe(-4);

    // Each printing carries its OWN art.
    expect(normal.imageUrl).toBe("https://img/sv1-25_normal.png");
    expect(rev.imageUrl).toBe("https://img/sv1-25_rev.png");
  });

  it("a variant with empty images falls back to the base c.images art (not dropped)", () => {
     
    const rows = buildCardRows(CARD as any, "set-db-1", Game.POKEMON, CARD.id);
    const holo = rows.find((r) => r.printing === "holofoil")!;
    expect(holo.imageUrl).toBe("https://img/sv1-25.png"); // base art fallback
    expect(holo.imageUrlHi).toBe("https://img/sv1-25_hi.png");
  });

  it("a base card with no image at all → that printing's imageUrl is null", () => {
    const noImg = {
      ...CARD,
      images: null,
      variants: [{ ...CARD.variants[2] }], // holofoil has images:null → no fallback
       
    } as any;
    const rows = buildCardRows(noImg, "set-db-1", Game.POKEMON, noImg.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].imageUrl).toBeNull();
    expect(rows[0].imageUrlHi).toBeNull();
  });
});

describe("buildPriceRows (scoped to one variant)", () => {
  it("builds deduped rows for a single variant's prices[]", () => {
    const rows = buildPriceRows(CARD.variants[1], "card-db-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cardId: "card-db-1",
      source: DataSource.SCRYDEX,
      variant: "reverse holofoil",
      condition: "NM",
      type: "raw",
      priceMarket: 4.25,
      priceLow: 3,
    });
  });
});

describe("pickBaseImageUrl", () => {
  it("returns the front entry of the base images array", () => {
     
    const img = pickBaseImageUrl(CARD as any);
    expect(img?.medium).toBe("https://img/sv1-25.png");
  });

  it("returns null for a card with no images", () => {
     
    expect(pickBaseImageUrl({ images: null } as any)).toBeNull();
  });
});
