import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Credit gate — the single enforcement point for "no live Scrydex credit spend
 * without owner approval" (plan §1/§7.5). We pin the pure estimate math and the
 * DENY-by-default assertion. Redis is mocked so the test is hermetic; with no
 * env override and a denying flag, the gate must refuse.
 */
vi.mock("@/lib/redis", () => ({
  redis: { get: vi.fn().mockResolvedValue(null) },
  RedisKeys: { scrydexCreditApproval: "scrydex:credit-approval" },
}));

import {
  estimateCredits,
  assertScrydexCreditsApproved,
  assertScrydexEnrichApproved,
  isScrydexLiveApproved,
  ScrydexCreditsNotApproved,
  SCRYDEX_CREDIT_COST,
} from "@/lib/services/scrydex-credit-gate";

afterEach(() => {
  delete process.env.SCRYDEX_LIVE_CREDITS_APPROVED;
  delete process.env.SCRYDEX_ONVIEW_ENABLED;
});

describe("estimateCredits", () => {
  it("uses documented per-op costs (history=3, vision=5, standard=1)", () => {
    expect(estimateCredits("priceHistory")).toBe(3);
    expect(estimateCredits("visionIdentify")).toBe(5);
    expect(estimateCredits("standard", 4)).toBe(4);
    expect(SCRYDEX_CREDIT_COST.priceHistory).toBe(3);
  });
});

describe("approval gate — DENY by default", () => {
  it("isScrydexLiveApproved is false with no env override and no flag", async () => {
    expect(await isScrydexLiveApproved()).toBe(false);
  });

  it("assert throws ScrydexCreditsNotApproved when denied", async () => {
    await expect(assertScrydexCreditsApproved("priceHistory", 1)).rejects.toBeInstanceOf(
      ScrydexCreditsNotApproved
    );
  });

  it("env override SCRYDEX_LIVE_CREDITS_APPROVED=true grants approval", async () => {
    process.env.SCRYDEX_LIVE_CREDITS_APPROVED = "true";
    expect(await isScrydexLiveApproved()).toBe(true);
    await expect(assertScrydexCreditsApproved("visionIdentify", 1)).resolves.toBeUndefined();
  });
});

describe("assertScrydexEnrichApproved — dual on-view/bulk gate (Bug A)", () => {
  it("(1) both flags off → rejects ScrydexCreditsNotApproved regardless of creditAuth", async () => {
    await expect(
      assertScrydexEnrichApproved("priceHistory", 1, "onview")
    ).rejects.toBeInstanceOf(ScrydexCreditsNotApproved);
    await expect(
      assertScrydexEnrichApproved("population", 1)
    ).rejects.toBeInstanceOf(ScrydexCreditsNotApproved);
  });

  it("(2) SCRYDEX_ONVIEW_ENABLED alone authorizes ONLY the creditAuth:'onview' path", async () => {
    process.env.SCRYDEX_ONVIEW_ENABLED = "true";
    // On-view auth present → authorized without opening the bulk gate.
    await expect(
      assertScrydexEnrichApproved("priceHistory", 1, "onview")
    ).resolves.toBeUndefined();
    // No on-view auth → falls back to the (still-denied) bulk gate → rejects.
    await expect(
      assertScrydexEnrichApproved("priceHistory", 1)
    ).rejects.toBeInstanceOf(ScrydexCreditsNotApproved);
  });

  it("(3) SCRYDEX_LIVE_CREDITS_APPROVED authorizes with OR without creditAuth", async () => {
    process.env.SCRYDEX_LIVE_CREDITS_APPROVED = "true";
    await expect(
      assertScrydexEnrichApproved("population", 1, "onview")
    ).resolves.toBeUndefined();
    await expect(
      assertScrydexEnrichApproved("population", 1)
    ).resolves.toBeUndefined();
  });
});
