import { describe, it, expect } from "vitest";
import {
  allocateBasis,
  realizedPnL,
  unrealizedPnL,
  aggregatePortfolio,
  statsFromLots,
} from "@/lib/utils/portfolio-accounting";

/**
 * Portfolio accounting math (plan §5). Pins the HONESTY rules: unresolved basis
 * is never 0, realized = proceeds − allocated basis (no fees), and partial
 * sales allocate basis proportionally so splits conserve total basis.
 */
describe("allocateBasis (proportional, conserves total)", () => {
  it("allocates per-copy basis across a sold quantity", () => {
    expect(allocateBasis(10, 3)).toBe(30);
  });
  it("splitting a 5-copy lot (basis 10/copy) across partial sales sums to 50", () => {
    expect(allocateBasis(10, 2)! + allocateBasis(10, 3)!).toBe(50);
  });
  it("null per-copy basis stays unresolved (null), never 0", () => {
    expect(allocateBasis(null, 4)).toBeNull();
  });
});

describe("realizedPnL (proceeds − basis, no fees)", () => {
  it("resolved: gross 95×2 − basis 40×2 = 110", () => {
    expect(realizedPnL(2, 95, 40)).toEqual({ status: "resolved", value: 110 });
  });
  it("unresolved basis → unresolved (never a number)", () => {
    expect(realizedPnL(2, 95, null)).toEqual({ status: "unresolved" });
  });
});

describe("unrealizedPnL", () => {
  it("resolved: (market 50 − basis 30) × 4 = 80", () => {
    expect(unrealizedPnL(4, 50, 30)).toEqual({ status: "resolved", value: 80 });
  });
  it("unresolved when market OR basis is null", () => {
    expect(unrealizedPnL(4, null, 30)).toEqual({ status: "unresolved" });
    expect(unrealizedPnL(4, 50, null)).toEqual({ status: "unresolved" });
  });
});

describe("aggregatePortfolio", () => {
  it("keeps unresolved lots out of the sums and counts them", () => {
    const stats = aggregatePortfolio(
      [
        { qty: 2, marketPerCopy: 50, basisPerCopy: 30 }, // mv 100, paid 60, unreal 40
        { qty: 1, marketPerCopy: 20, basisPerCopy: null }, // unresolved basis
      ],
      [
        { qty: 1, grossPerCopy: 80, basisPerCopy: 30 }, // realized 50
        { qty: 1, grossPerCopy: 80, basisPerCopy: null }, // unresolved
      ]
    );
    expect(stats.marketValue).toBe(120); // 100 + 20 (market known even if basis isn't)
    expect(stats.paid).toBe(60); // only the resolved lot
    expect(stats.realized).toBe(50);
    expect(stats.unrealized).toBe(40); // only the lot with both resolved
    expect(stats.unresolvedCount).toBe(2); // 1 active + 1 sold
  });
});

/**
 * statsFromLots — the SOURCE-OF-TRUTH adapter the dashboard AND the portfolio
 * page both call, so the two views can never show a different value for the
 * same card. These lock the exact bugs the old inline dashboard math had.
 */
describe("statsFromLots (shared dashboard + portfolio aggregation)", () => {
  it("market value sums ACTIVE lots only; sold lots excluded", () => {
    const s = statsFromLots([
      { quantity: 2, purchasePrice: 10, marketPrice: 25, isSold: false },
      // sold lot: soldPrice is the GROSS TOTAL for qty 3 (gross-per-copy × 3)
      { quantity: 3, purchasePrice: 10, marketPrice: 25, isSold: true, soldPrice: 90 },
    ]);
    expect(s.marketValue).toBe(50); // 25 × 2 active only (sold 3 excluded)
    expect(s.paid).toBe(20); // active cost basis 10 × 2 only
  });

  it("realized uses soldPrice as a GROSS TOTAL — never re-multiplied by quantity", () => {
    // soldPrice 90 is already the total for 3 copies; basis 10/copy × 3 = 30.
    // Correct realized = 90 − 30 = 60. The old inline bug did (90−10)×3 = 240.
    const s = statsFromLots([
      { quantity: 3, purchasePrice: 10, marketPrice: null, isSold: true, soldPrice: 90 },
    ]);
    expect(s.realized).toBe(60);
  });

  it("null cost basis is NOT counted as $0 paid — excluded and counted unresolved", () => {
    const s = statsFromLots([
      { quantity: 1, purchasePrice: null, marketPrice: 40, isSold: false },
      { quantity: 2, purchasePrice: 15, marketPrice: 40, isSold: false },
    ]);
    expect(s.paid).toBe(30); // only the resolved lot (15 × 2); null NOT 0
    expect(s.marketValue).toBe(120); // market known for both (40 × 3)
    expect(s.unresolvedCount).toBe(1); // the null-basis lot
    expect(s.unrealized).toBe(50); // only the both-resolved lot: (40−15)×2
  });

  it("null marketPrice on an active lot is NOT counted as $0 value", () => {
    const s = statsFromLots([
      { quantity: 2, purchasePrice: 10, marketPrice: null, isSold: false },
    ]);
    expect(s.marketValue).toBe(0); // no fabricated market value
    expect(s.unrealized).toBe(0); // unresolved (market unknown) → not summed
    // Basis IS resolved (10); only a null COST BASIS marks a lot unresolved,
    // so a known-cost / unknown-market lot is honestly excluded from value
    // without being flagged as an unresolved-cost-basis lot.
    expect(s.unresolvedCount).toBe(0);
  });

  it("partitioning by collection then summing equals the single-pass total (no double count)", () => {
    const collA = [{ quantity: 1, purchasePrice: 5, marketPrice: 12, isSold: false }];
    const collB = [{ quantity: 2, purchasePrice: 8, marketPrice: 20, isSold: false }];
    const perColl = statsFromLots(collA).marketValue + statsFromLots(collB).marketValue;
    const whole = statsFromLots([...collA, ...collB]).marketValue;
    expect(perColl).toBe(whole);
    expect(whole).toBe(52); // 12 + 20×2 — each lot counted exactly once
  });
});

/**
 * BUG-1 (graded value): a graded holding is worth its GRADED price, not the raw
 * aggregate marketPrice. statsFromLots now resolves graded lots via the SAME
 * graded-price.ts helper the card-detail / add-sheet use (curated lookup, else
 * a coarse per-grade multiplier). Raw lots must be untouched.
 */
describe("statsFromLots graded resolution (BUG-1)", () => {
  it("a PSA 10 lot values at the CURATED graded price, not raw", () => {
    // Charizard Base Set PSA 10 is curated at raw 3500 → graded 35000
    // (graded-price.ts GRADED_PRICE_LOOKUP, mirrors golden_prices.json).
    const s = statsFromLots([
      { quantity: 1, purchasePrice: 3500, marketPrice: 3500, condition: "PSA 10", isSold: false },
    ]);
    expect(s.marketValue).toBe(35000); // graded value, NOT raw 3500
    expect(s.unrealized).toBe(31500); // 35000 − 3500, not $0
  });

  it("a NON-curated graded lot uses the coarse fallback multiplier (×2.5 for PSA 10)", () => {
    // raw 100 with no curated (raw,grade) hit → fallback 100 × 2.5 = 250.
    const s = statsFromLots([
      { quantity: 2, purchasePrice: 100, marketPrice: 100, condition: "PSA 10", isSold: false },
    ]);
    expect(s.marketValue).toBe(500); // 250 per copy × 2
    expect(s.unrealized).toBe(300); // (250 − 100) × 2
  });

  it("a raw (ungraded) lot is unchanged — no graded resolution applied", () => {
    const s = statsFromLots([
      { quantity: 2, purchasePrice: 10, marketPrice: 25, condition: "Near Mint", isSold: false },
      { quantity: 1, purchasePrice: 10, marketPrice: 25, isSold: false }, // no condition
    ]);
    expect(s.marketValue).toBe(75); // 25 × 3 — raw price kept verbatim
  });

  it("graded resolution never applies to a SOLD lot's proceeds (realized stays gross)", () => {
    // soldPrice is the recorded gross total; a sold graded lot must not have its
    // proceeds inflated by the graded multiplier.
    const s = statsFromLots([
      { quantity: 1, purchasePrice: 100, marketPrice: 100, condition: "PSA 10", isSold: true, soldPrice: 300 },
    ]);
    expect(s.marketValue).toBe(0); // sold → excluded from market value
    expect(s.realized).toBe(200); // 300 gross − 100 basis, no graded multiplier
  });
});

/**
 * BUG-2 (You page): the Profile page's Paid/Value must come from statsFromLots,
 * not an inline reduce over ALL rows. This pins the engine output for a dataset
 * that mixes an active lot with a sold lot (the exact shape the You page maps),
 * so the sold lot can never be double-counted as an active holding again.
 */
describe("You-page aggregation routes through statsFromLots (BUG-2)", () => {
  it("Paid/Value exclude the sold lot (report's $12/$10 example, not $24/$20)", () => {
    const s = statsFromLots([
      { quantity: 1, purchasePrice: 10, marketPrice: 12, isSold: false },
      { quantity: 1, purchasePrice: 10, marketPrice: 12, isSold: true, soldPrice: 25 },
    ]);
    expect(s.marketValue).toBe(12); // active only — NOT 24
    expect(s.paid).toBe(10); // active basis only — NOT 20
  });
});
