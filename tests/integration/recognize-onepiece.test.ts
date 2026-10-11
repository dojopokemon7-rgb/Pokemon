import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * One Piece scanning fix — POST /api/cards/recognize.
 *   (a) TEXT path scopes the candidate pool to One Piece sets
 *       (set.externalId startsWith "onepiece-") when game="onepiece", and a
 *       One Piece collector-number input (e.g. "OP01-064") resolves to a One
 *       Piece Card (findings E6).
 *   (b) Vision path: a match whose Scrydex-native id does NOT join to a local
 *       Card row (the One Piece Bandai-vs-Scrydex id-namespace mismatch, E5)
 *       falls through to ocrSource:"unavailable" and consumes NO allowance,
 *       instead of a silent empty success that suppresses the fallback.
 *
 * Everything external is MOCKED: no live DB, no network, no Scrydex credits.
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

describe("POST /api/cards/recognize One Piece", () => {
  it("TEXT path scopes the pool to One Piece sets and resolves OP01-064", async () => {
    prismaMock.card.findMany.mockResolvedValue([
      {
        // One Piece rows store the Bandai code as both externalId AND the
        // collector `number` (apitcg uses `p.code` like "OP01-064") — so the
        // engine's +50 number signal fires on the "OP01-064" set-code reading.
        externalId: "OP01-064",
        name: "Monkey.D.Luffy",
        number: "OP01-064",
        imageUrl: "/api/one-piece-img/OP01-064",
        imageUrlHi: null,
        set: { name: "Romance Dawn [OP-01]" },
      },
    ]);

    const res = await POST(req({ text: "OP01-064 Luffy", game: "onepiece", source: "tesseract" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    // The candidate pool was scoped to One Piece sets.
    const whereArg = prismaMock.card.findMany.mock.calls[0][0].where;
    expect(whereArg.set.externalId.startsWith).toBe("onepiece-");
    // The One Piece row resolves (externalId is the Bandai code — AGENTS rule 3).
    expect(data.candidates[0].id).toBe("OP01-064");
    // One Piece candidate image is the same-origin proxy, never a hot-linked
    // Bandai URL (AGENTS rule 13).
    expect(data.candidates[0].imageUrl).toBe("/api/one-piece-img/OP01-064");
  });

  it("Vision match with an unresolvable Scrydex id falls through, consuming NO allowance", async () => {
    // A Scrydex-native One Piece id that does not match any local Bandai externalId.
    scrydex.identifyCard.mockResolvedValue([
      { cardId: "op01-064-scrydex", score: 0.9, name: "Monkey.D.Luffy" },
    ]);
    prismaMock.card.findMany.mockResolvedValue([]); // no local row joins

    const res = await POST(req({ image: JPEG_B64, game: "onepiece" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ocrSource).toBe("unavailable");
    expect(data.candidates).toEqual([]);
    expect(scrydex.identifyCard).toHaveBeenCalledTimes(1);
    expect(allowance.reserve).not.toHaveBeenCalled(); // no slot burned on a dead-end
  });
});
