import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Scanner top-N candidate fix — POST /api/cards/recognize Vision branch now
 * returns the TOP-N matches (not just matches[0]), each carrying its collector
 * `number` + set, in Scrydex rank order. Everything external is MOCKED: no live
 * DB, no network, no Scrydex credits.
 */

const prismaMock = vi.hoisted(() => ({
  card: { findMany: vi.fn(), findUnique: vi.fn() },
  scanFeedback: { create: vi.fn(), update: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const authMock = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: authMock.getSession } } }));

const scrydex = vi.hoisted(() => ({ identifyCard: vi.fn(), approved: vi.fn() }));
vi.mock("@/lib/services/scrydex.service", () => ({ identifyCard: scrydex.identifyCard }));
vi.mock("@/lib/services/scrydex-credit-gate", () => ({ isScrydexLiveApproved: scrydex.approved }));

const allowance = vi.hoisted(() => ({ reserve: vi.fn() }));
vi.mock("@/lib/services/scan-allowance.service", () => ({
  getScanAllowance: vi.fn(async () => ({ used: 0, limit: 10, remaining: 10 })),
  reserveSuccessfulScan: allowance.reserve,
}));

import { POST } from "@/app/api/cards/recognize/route";

const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]).toString("base64");

function req(body: unknown) {
  return new Request("http://localhost/api/cards/recognize", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  scrydex.approved.mockResolvedValue(true); // credit gate approved for the Vision path
  authMock.getSession.mockResolvedValue({ user: { id: "user_1" } });
  allowance.reserve.mockResolvedValue({ ok: true, allowance: { used: 1, limit: 10, remaining: 9 } });
  prismaMock.scanFeedback.create.mockResolvedValue({ id: "fb_1" });
});

describe("POST /api/cards/recognize top-N Vision candidates", () => {
  it("returns ALL matches with collector numbers, re-sorted to Vision rank order", async () => {
    // Vision rank order: sv10-081 (top), svp-205, base1-4.
    scrydex.identifyCard.mockResolvedValue([
      { cardId: "sv10-081", score: 1, name: "Team Rocket's Mewtwo ex" },
      { cardId: "svp-205", score: 0.9, name: "Team Rocket's Mewtwo ex" },
      { cardId: "base1-4", score: 0.7, name: "Charizard" },
    ]);
    // findMany returns rows in a DIFFERENT order than `ids` to prove re-sorting.
    prismaMock.card.findMany.mockResolvedValue([
      { externalId: "svp-205", name: "Team Rocket's Mewtwo ex", number: "205", imageUrl: "svp.png", imageUrlHi: null, set: { name: "S&V Promo Cards" } },
      { externalId: "base1-4", name: "Charizard", number: "4", imageUrl: null, imageUrlHi: "hi.png", set: { name: "Base" } },
      { externalId: "sv10-081", name: "Team Rocket's Mewtwo ex", number: "081/182", imageUrl: "sv10.png", imageUrlHi: null, set: { name: "Destined Rivals" } },
    ]);

    const res = await POST(req({ image: JPEG_B64, game: "pokemon" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ocrSource).toBe("vision");
    expect(data.candidates).toHaveLength(3);
    // Rank order preserved (Vision), NOT findMany order.
    expect(data.candidates.map((c: { id: string }) => c.id)).toEqual(["sv10-081", "svp-205", "base1-4"]);
    // Collector numbers carried per row.
    expect(data.candidates[0].number).toBe("081/182");
    expect(data.candidates[1].number).toBe("205");
    expect(data.candidates[2].number).toBe("4");
    // Set names + image fallback (imageUrl ?? imageUrlHi).
    expect(data.candidates[0].set).toBe("Destined Rivals");
    expect(data.candidates[1].imageUrl).toBe("svp.png");
    expect(data.candidates[2].imageUrl).toBe("hi.png");
    // Confidence is clamped 0..1 so the UI never renders >100%.
    expect(data.candidates[0].confidence).toBe(1);
    expect(allowance.reserve).toHaveBeenCalledTimes(1);
  });

  it("drops Vision ids that don't resolve to a local Card, keeping rank order", async () => {
    scrydex.identifyCard.mockResolvedValue([
      { cardId: "sv10-081", score: 1, name: "Team Rocket's Mewtwo ex" },
      { cardId: "ghost-999", score: 0.8, name: "Nonexistent" },
    ]);
    prismaMock.card.findMany.mockResolvedValue([
      { externalId: "sv10-081", name: "Team Rocket's Mewtwo ex", number: "081/182", imageUrl: "sv10.png", imageUrlHi: null, set: { name: "Destined Rivals" } },
    ]);

    const res = await POST(req({ image: JPEG_B64, game: "pokemon" }));
    const data = await res.json();
    expect(data.candidates).toHaveLength(1);
    expect(data.candidates[0].id).toBe("sv10-081");
  });

  it("empty identify result returns ocrSource unavailable and consumes NO allowance", async () => {
    scrydex.identifyCard.mockResolvedValue([]);

    const res = await POST(req({ image: JPEG_B64, game: "pokemon" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ocrSource).toBe("unavailable");
    expect(data.candidates).toEqual([]);
    expect(scrydex.identifyCard).toHaveBeenCalledTimes(1);
    expect(allowance.reserve).not.toHaveBeenCalled();
  });
});
