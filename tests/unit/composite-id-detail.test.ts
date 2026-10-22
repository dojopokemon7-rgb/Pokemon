import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { decodeRouteId } from "@/lib/utils/card-number";
import { listVariants } from "@/lib/utils/raw-price";
import { buildChips, type CurrentPriceRow } from "@/app/(dashboard)/search/[id]/price-history-chart";

/**
 * Regression for the COMPOSITE-ID-ONLY card-detail render bug.
 *
 * `/search/base1-2` (BASE id) rendered fully; `/search/base1-2::<variant>`
 * (COMPOSITE id, URL-encoded `%3A%3A`) rendered only a lone Raw chip — no grade
 * chips, no variant dropdown, empty chart — even though the /prices API returns
 * 57 rows. ROOT CAUSE: App Router `useParams()` hands back the ENCODED segment;
 * the page never decoded it, so `encodeURIComponent(id)` DOUBLE-encoded the
 * fetch URL (`%253A%253A`), the server missed the externalId and 200-emptied,
 * and the TanStack query key diverged from the grid's prefetch key.
 *
 * This test drives the component's prices data path with a MOCKED fetch (no
 * network, no DB, no render): the queryFn URL is built exactly as page.tsx does
 * — `` `/api/cards/${encodeURIComponent(id)}/prices` `` — and the mock returns
 * the 57-row fixture ONLY for the correct single-encoded URL. It proves the
 * fix (decode → populated chips/variants) AND locks in the regression (no
 * decode → raw-only chip, no variants).
 */

// The 57-row shape from the user's SQL dump for
// base1-15::unlimitedShadowlessHolofoil: 5 raw NM + ~52 graded across
// PSA/CGC/BGS/SGC/TAG/ACE (one row per company+grade). All carry the single
// stored variant "unlimitedShadowlessHolofoil".
const VARIANT = "unlimitedShadowlessHolofoil";
function raw(price: number): CurrentPriceRow {
  return { variant: VARIANT, condition: "NM", company: null, grade: null, type: "raw", priceMarket: price };
}
function graded(company: string, grade: string, price: number): CurrentPriceRow {
  return { variant: VARIANT, condition: "NM", company, grade, type: "graded", priceMarket: price };
}
const FIXTURE_ROWS: CurrentPriceRow[] = [
  raw(365), raw(209.55), raw(159.79), raw(116.65), raw(494.19),
  graded("SGC", "2", 71), graded("CCIC", "9.5", 23.5), graded("SGC", "8", 293.36),
  graded("SGC", "6", 185), graded("SGC", "5", 108), graded("SGC", "4", 125),
  graded("PSA", "10", 12427.66), graded("PSA", "9", 1876.95), graded("PSA", "8.5", 935.66),
  graded("PSA", "8", 874.55), graded("PSA", "7", 1006), graded("PSA", "6", 510.04),
  graded("CGC", "10", 2200.18), graded("CGC", "9.5", 47.99), graded("CGC", "9", 933.38),
  graded("CGC", "8.5", 619.74), graded("CGC", "8", 566.23),
  graded("BGS", "9.5", 3601.02), graded("BGS", "9", 1527.99), graded("BGS", "8.5", 1087.33),
  graded("TAG", "9", 1879.43), graded("TAG", "6", 239.99), graded("ACE", "10", 93.24),
];

// The EXACT URL page.tsx's prices queryFn builds for a given route-param id.
const pricesUrl = (routeParamId: string) => `/api/cards/${encodeURIComponent(routeParamId)}/prices`;

// The correct single-encoded URL the server actually resolves (literal `::`
// → encoded once). Any double-encoded or mismatched URL misses → 200-empty.
const GOOD_URL = pricesUrl("base1-15::unlimitedShadowlessHolofoil");

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    if (url === GOOD_URL) {
      return { ok: true, json: async () => ({ prices: FIXTURE_ROWS, weeklyChangePct: null }) } as Response;
    }
    // Server graceful-empty (RULE 7) for a missed/double-encoded externalId.
    return { ok: true, json: async () => ({ prices: [], weeklyChangePct: null }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Mirror page.tsx's prices queryFn exactly, taking the id the component would
// use (the DECODED route param in the fixed code, the RAW param in the old).
async function loadPrices(componentId: string): Promise<CurrentPriceRow[]> {
  const res = await fetch(pricesUrl(componentId));
  const json = await (res as Response).json();
  return (json as { prices: CurrentPriceRow[] }).prices ?? [];
}

describe("composite-id card detail — prices data path", () => {
  // The raw (encoded) value App Router's useParams() hands the page.
  const ENCODED_PARAM = "base1-15%3A%3AunlimitedShadowlessHolofoil";

  it("renders from the 57 rows after decoding the route id (THE fix)", async () => {
    const id = decodeRouteId(ENCODED_PARAM); // page.tsx now does this
    expect(id).toBe("base1-15::unlimitedShadowlessHolofoil");

    const rows = await loadPrices(id);
    expect(fetchMock).toHaveBeenCalledWith(GOOD_URL); // single-encoded, resolves
    expect(rows).toHaveLength(FIXTURE_ROWS.length);

    // Grade chips are built over the graded rows: one group per company present.
    const chipPrice = { raw: 365 };
    const groups = buildChips(rows, chipPrice);
    const groupNames = groups.map((g) => g.group);
    expect(groupNames).toContain("Raw");
    for (const co of ["PSA", "CGC", "BGS", "SGC", "TAG", "ACE"]) {
      expect(groupNames).toContain(co);
    }
    // More than just the Raw chip.
    const totalChips = groups.flatMap((g) => g.chips).length;
    expect(totalChips).toBeGreaterThan(1);

    // Variant handling: the stored variant is present.
    const variants = listVariants(rows);
    expect(variants).toContain(VARIANT);
    expect(variants.length).toBeGreaterThanOrEqual(1);
  });

  it("regression: raw-only + no variants when the route id is NOT decoded", async () => {
    const id = ENCODED_PARAM; // the OLD buggy behavior: used the encoded param
    const rows = await loadPrices(id);

    // Double-encoded URL (%253A%253A) → not GOOD_URL → server 200-empties.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/cards/base1-15%253A%253AunlimitedShadowlessHolofoil/prices",
    );
    expect(rows).toHaveLength(0);

    const groups = buildChips(rows, { raw: 896.06 });
    const totalChips = groups.flatMap((g) => g.chips).length;
    expect(totalChips).toBe(1); // only the Raw chip
    expect(groups.flatMap((g) => g.chips)[0].id).toBe("raw");
    expect(listVariants(rows)).toHaveLength(0); // no variant dropdown
  });
});
