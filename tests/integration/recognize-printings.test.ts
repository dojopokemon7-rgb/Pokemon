import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * One Piece "which printing?" expansion — POST /api/cards/recognize.
 *
 * After Scrydex Vision resolves a One Piece match to a local Card, the route
 * appends the OTHER local printings sharing the same `name` (One Piece sets
 * only) as additional pickable candidates with a sentinel confidence:0, so the
 * user can pick the exact printing. Local DB only — NO Scrydex credits, NO
 * live network. Pokémon takes the exact same path it does today (no expansion).
 *
 * Because the One Piece Vision branch now issues TWO prisma.card.findMany calls
 * (first the Vision-id resolve, then the sibling-name expansion), the mock is
 * driven with mockResolvedValueOnce twice. Everything external is MOCKED.
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
  scrydex.approved.mockResolvedValue(true);
  authMock.getSession.mockResolvedValue({ user: { id: "user_1" } });
  allowance.reserve.mockResolvedValue({ ok: true, allowance: { used: 1, limit: 10, remaining: 9 } });
  prismaMock.scanFeedback.create.mockResolvedValue({ id: "fb_1" });
});

describe("POST /api/cards/recognize One Piece printing expansion", () => {
  it("appends same-name local printings as sibling candidates after the Vision match", async () => {
    scrydex.identifyCard.mockResolvedValue([
      { cardId: "OP05-119", score: 0.92, name: "Monkey.D.Luffy" },
    ]);
    // 1st findMany: Vision-id resolve → the matched local Card.
    prismaMock.card.findMany.mockResolvedValueOnce([
      {
        externalId: "OP05-119",
        name: "Monkey.D.Luffy",
        number: "OP05-119",
        imageUrl: "/api/one-piece-img/OP05-119",
        imageUrlHi: null,
        set: { name: "Awakening of the New Era [OP-05]" },
      },
    ]);
    // 2nd findMany: same-name sibling printings in other One Piece sets.
    prismaMock.card.findMany.mockResolvedValueOnce([
      {
        externalId: "OP01-003",
        name: "Monkey.D.Luffy",
        number: "OP01-003",
        imageUrl: "/api/one-piece-img/OP01-003",
        imageUrlHi: null,
        set: { name: "Romance Dawn [OP-01]" },
      },
      {
        externalId: "ST01-012",
        name: "Monkey.D.Luffy",
        number: "ST01-012",
        imageUrl: "/api/one-piece-img/ST01-012",
        imageUrlHi: null,
        set: { name: "Straw Hat Crew [ST-01]" },
      },
    ]);

    const res = await POST(req({ image: JPEG_B64, game: "onepiece" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ocrSource).toBe("vision");

    // Vision match stays first, with its real score — rank order preserved.
    expect(data.candidates[0].id).toBe("OP05-119");
    expect(data.candidates[0].confidence).toBeCloseTo(0.92);

    // Siblings appended AFTER the Vision match, carrying number/set/proxy image
    // and a sentinel confidence of 0 (NOT a fabricated %).
    expect(data.candidates).toHaveLength(3);
    const sib1 = data.candidates[1];
    const sib2 = data.candidates[2];
    expect(sib1.id).toBe("OP01-003");
    expect(sib1.number).toBe("OP01-003");
    expect(sib1.set).toBe("Romance Dawn [OP-01]");
    expect(sib1.imageUrl).toBe("/api/one-piece-img/OP01-003");
    expect(sib1.confidence).toBe(0);
    expect(sib2.id).toBe("ST01-012");
    expect(sib2.confidence).toBe(0);

    // Deduped by externalId — the Vision match is not duplicated as a sibling.
    const ids = data.candidates.map((c: { id: string }) => c.id);
    expect(new Set(ids).size).toBe(ids.length);

    // The sibling query is scoped to One Piece sets, keyed on the resolved
    // name, and excludes the already-included Vision id.
    const siblingWhere = prismaMock.card.findMany.mock.calls[1][0].where;
    expect(siblingWhere.set.externalId.startsWith).toBe("onepiece-");
    expect(siblingWhere.name.in).toContain("Monkey.D.Luffy");
    expect(siblingWhere.externalId.notIn).toContain("OP05-119");
  });

  it("does NOT expand same-name printings for a Pokémon Vision match", async () => {
    scrydex.identifyCard.mockResolvedValue([
      { cardId: "base1-4", score: 0.95, name: "Charizard" },
    ]);
    prismaMock.card.findMany.mockResolvedValueOnce([
      {
        externalId: "base1-4",
        name: "Charizard",
        number: "4",
        imageUrl: "https://img.pokemontcg.io/base1/4.png",
        imageUrlHi: null,
        set: { name: "Base Set" },
      },
    ]);

    const res = await POST(req({ image: JPEG_B64, game: "pokemon" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ocrSource).toBe("vision");
    // Only the Vision resolve query ran — no same-name expansion for Pokémon.
    expect(prismaMock.card.findMany).toHaveBeenCalledTimes(1);
    expect(data.candidates).toHaveLength(1);
    // No sentinel-confidence siblings leaked into the Pokémon result.
    expect(data.candidates.some((c: { confidence: number }) => c.confidence === 0)).toBe(false);
  });
});
