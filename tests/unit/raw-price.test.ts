import { describe, it, expect } from "vitest";
import {
  RAW_CONDITION_ORDER,
  isRawRow,
  rowPrice,
  pickBestRaw,
  listVariants,
  pickDefaultVariant,
  variantLabel,
  pickHeadlineRaw,
  parseGradedCondition,
  pickGradedFromRows,
  type PriceRowLike,
} from "@/lib/utils/raw-price";

const raw = (variant: string, condition: string, priceMarket: number | null, priceLow: number | null = null): PriceRowLike => ({
  variant, type: "raw", condition, company: null, grade: null, priceMarket, priceLow,
});
// Legacy graded writer: graded rows ALSO carry condition "NM".
const graded = (variant: string, grade: string, priceMarket: number, condition = "NM"): PriceRowLike => ({
  variant, type: "graded", condition, company: "PSA", grade, priceMarket, priceLow: null,
});

describe("raw-price", () => {
  it("condition order uses DM (not DMG)", () => {
    expect([...RAW_CONDITION_ORDER]).toEqual(["NM", "LP", "MP", "HP", "DM"]);
  });

  it("NM wins over LP", () => {
    expect(pickBestRaw([raw("normal", "LP", 5), raw("normal", "NM", 9)])?.price).toBe(9);
  });

  it("NM missing -> LP", () => {
    const r = pickBestRaw([raw("normal", "MP", 3), raw("normal", "LP", 5)]);
    expect(r).toMatchObject({ price: 5, condition: "LP" });
  });

  it("only HP/DM -> HP", () => {
    expect(pickBestRaw([raw("normal", "DM", 1), raw("normal", "HP", 2)])).toMatchObject({ price: 2, condition: "HP" });
  });

  it("graded-only (incl. legacy graded NM rows) -> null", () => {
    expect(pickHeadlineRaw([graded("firstEditionHolofoil", "10", 83435.13)])).toBeNull();
    expect(pickBestRaw([graded("normal", "10", 100)])).toBeNull();
  });

  it("empty / null prices -> null, never 0", () => {
    expect(pickHeadlineRaw([])).toBeNull();
    expect(pickHeadlineRaw([raw("normal", "NM", null, null)])).toBeNull();
  });

  it("priceMarket null falls back to priceLow", () => {
    expect(rowPrice(raw("normal", "NM", null, 4.5))).toBe(4.5);
    expect(pickHeadlineRaw([raw("normal", "NM", null, 4.5)])).toBe(4.5);
  });

  it("legacy null type counts raw only without company/grade", () => {
    expect(isRawRow({ type: null, company: null, grade: null })).toBe(true);
    expect(isRawRow({ type: null, company: "PSA", grade: "10" })).toBe(false);
    expect(isRawRow({ type: "graded", company: null, grade: null })).toBe(false);
  });

  describe("Shining Gyarados fixture (neo3-65)", () => {
    const rows: PriceRowLike[] = [
      graded("firstEditionHolofoil", "10", 83435.13),
      raw("unlimitedHolofoil", "LP", 782.55),
      raw("unlimitedHolofoil", "MP", 551.29),
      raw("unlimitedHolofoil", "HP", 500),
      raw("unlimitedHolofoil", "DM", 384.94),
      graded("unlimitedHolofoil", "10", 29981.97),
    ];
    it("headline is the LP raw price, never the PSA 10", () => {
      expect(pickDefaultVariant(rows)).toBe("unlimitedHolofoil");
      expect(pickHeadlineRaw(rows)).toBe(782.55);
    });
    it("is independent of input order", () => {
      for (let i = 0; i < rows.length; i++) {
        const rot = [...rows.slice(i), ...rows.slice(0, i)];
        expect(pickHeadlineRaw(rot)).toBe(782.55);
        expect(pickHeadlineRaw([...rot].reverse())).toBe(782.55);
      }
    });
  });

  it("multi raw variants resolve deterministically by VARIANT_PRIORITY", () => {
    const a = [raw("holofoil", "NM", 154.02), raw("normal", "NM", 0.55)];
    expect(pickDefaultVariant(a)).toBe("normal");
    expect(pickHeadlineRaw(a)).toBe(0.55);
    expect(pickHeadlineRaw([...a].reverse())).toBe(0.55);
  });

  it("better condition beats variant priority", () => {
    const a = [raw("normal", "LP", 1), raw("holofoil", "NM", 9)];
    expect(pickDefaultVariant(a)).toBe("holofoil");
  });

  it("listVariants returns distinct priced variants deterministically", () => {
    const rows = [raw("holofoil", "NM", 1), graded("firstEdition", "10", 5), raw("normal", "NM", 1), raw("normal", "LP", 1), raw("ghost", "NM", null)];
    expect(listVariants(rows)).toEqual(listVariants([...rows].reverse()));
    expect(listVariants(rows).sort()).toEqual(["firstEdition", "holofoil", "normal"]);
  });

  it("variant-only graded card defaults to first listed variant", () => {
    expect(pickDefaultVariant([graded("holofoil", "10", 5)])).toBe("holofoil");
    expect(pickDefaultVariant([])).toBeNull();
  });

  it("variantLabel humanises camelCase", () => {
    expect(variantLabel("firstEditionShadowlessHolofoil")).toBe("First Edition Shadowless Holofoil");
    expect(variantLabel("normal")).toBe("Normal");
  });

  describe("parseGradedCondition", () => {
    it("parses graded labels into company + grade", () => {
      expect(parseGradedCondition("PSA 10")).toEqual({ company: "PSA", grade: "10" });
      expect(parseGradedCondition("CGC 9.5")).toEqual({ company: "CGC", grade: "9.5" });
      expect(parseGradedCondition("BGS 10")).toEqual({ company: "BGS", grade: "10" });
    });
    it("is case-insensitive and tolerates extra whitespace", () => {
      expect(parseGradedCondition("psa  9")).toEqual({ company: "PSA", grade: "9" });
    });
    it("returns null for raw / unparseable conditions", () => {
      expect(parseGradedCondition("NM")).toBeNull();
      expect(parseGradedCondition("")).toBeNull();
      expect(parseGradedCondition(null)).toBeNull();
      expect(parseGradedCondition(undefined)).toBeNull();
      expect(parseGradedCondition("PSA")).toBeNull(); // company but no grade
    });
  });

  describe("pickGradedFromRows", () => {
    it("returns the matching graded row priceMarket", () => {
      const rows = [raw("normal", "NM", 10), graded("normal", "10", 342.73)];
      expect(pickGradedFromRows(rows, "PSA", "10")).toBe(342.73);
    });
    it("returns null when no graded row matches the grade", () => {
      const rows = [raw("normal", "NM", 10), graded("normal", "9", 100)];
      expect(pickGradedFromRows(rows, "PSA", "10")).toBeNull();
    });
    it("returns null for raw-only rows", () => {
      expect(pickGradedFromRows([raw("normal", "NM", 10)], "PSA", "10")).toBeNull();
    });
    it("prefers the default variant when several variants carry the grade", () => {
      const rows = [
        raw("normal", "NM", 5),
        graded("normal", "10", 300),
        graded("holofoil", "10", 999),
      ];
      // pickDefaultVariant -> "normal" (raw NM present), so the normal graded row wins.
      expect(pickGradedFromRows(rows, "PSA", "10")).toBe(300);
    });
    it("honors an explicit variant argument", () => {
      const rows = [graded("normal", "10", 300), graded("holofoil", "10", 999)];
      expect(pickGradedFromRows(rows, "PSA", "10", "holofoil")).toBe(999);
    });
  });
});
