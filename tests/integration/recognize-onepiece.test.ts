import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * One Piece scanning fix — POST /api/cards/recognize.
 *   (a) TEXT path scopes the candidate pool to One Piece sets
 *       (set.externalId startsWith "onepiece-") when game="onepiece", and a
 *       One Piece collector-number input (e.g. "OP01-064") resolves to a One
 *       Piece Card (findings E6).
 *   (b) Vision path (positive): a One Piece Vision match whose id is the FULL
 *       Bandai code (e.g. "OP05-119") RESOLVES to a local Card via externalId
 *       and returns a candidate with ocrSource:"vision" — same as Pokémon,
 *       NOT forced to OCR — reserving exactly one allowance slot.
 *   (c) Vision path (genuine miss): a match whose id does NOT join to any
 *       local Card row falls through to ocrSource:"unavailable" and consumes
 *       NO allowance, instead of a silent empty success that suppresses the
 *       tesseract fallback. This is the safety net for a real catalog miss on
 *       EITHER game, not a One-Piece-forcing device.
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
        // One Piece rows store the FULL Bandai code in `number` because the
        // write path runs deriveStoredCardNumber(externalId, isOnePiece=true),
        // which returns the externalId unchanged (NOT apitcg mapping — apitcg
        // never sets `number`). This is what makes the recognizer's +50 number
        // signal fire on the "OP01-064" set-code reading; storing the bare tail
        // ("064") would never match normalizeNumber("OP01-064") = "op01-064".
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
    // Regression guard: the +50 number signal fired because the stored `number`
    // is the FULL Bandai code. If a future change reverts to the bare tail
    // ("064"), the number would no longer match the parsed "op01-064" and this
    // card would drop below the confidence gate — so assert the full code is the
    // resolved candidate's number.
    expect(data.candidates[0].number).toBe("OP01-064");
    // One Piece candidate image is the same-origin proxy, never a hot-linked
    // Bandai URL (AGENTS rule 13).
    expect(data.candidates[0].imageUrl).toBe("/api/one-piece-img/OP01-064");
  });

  it("Vision match with a Bandai-code id resolves to a local Card via externalId (Vision-first, not forced to OCR)", async () => {
    // A live 5-credit probe confirmed Scrydex Vision returns the FULL Bandai
    // code as card.id for One Piece, which IS the local Card.externalId. So a
    // One Piece Vision match resolves directly, exactly like Pokémon.
    // clampScore caps the probe's 1.135 → 1 upstream in the service, so the
    // route consumes the already-clamped value.
    scrydex.identifyCard.mockResolvedValue([
      { cardId: "OP05-119", score: 1, name: "Monkey.D.Luffy" },
    ]);
    prismaMock.card.findMany.mockResolvedValue([
      {
        externalId: "OP05-119",
        name: "Monkey.D.Luffy",
        number: "OP05-119",
        imageUrl: "/api/one-piece-img/OP05-119",
        imageUrlHi: null,
        set: { name: "Awakening of the New Era [OP-05]" },
      },
    ]);

    const res = await POST(req({ image: JPEG_B64, game: "onepiece" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    // The core guarantee: Vision-first, NOT forced to the OCR fallback.
    expect(data.ocrSource).toBe("vision");
    // The One Piece Bandai code resolved to the local Card via externalId.
    expect(data.candidates[0].id).toBe("OP05-119");
    // Collector number is the full Bandai code (3329bb6 backfill) — top-N.
    expect(data.candidates[0].number).toBe("OP05-119");
    // RULE 13: candidate image is the same-origin proxy path from the Card
    // ROW, never a raw Scrydex image URL.
    expect(data.candidates[0].imageUrl).toBe("/api/one-piece-img/OP05-119");
    // The resolve joined Scrydex match ids against local Card.externalId.
    expect(prismaMock.card.findMany.mock.calls[0][0].where.externalId.in).toContain("OP05-119");
    // A successful Vision scan reserves exactly one allowance slot.
    expect(allowance.reserve).toHaveBeenCalledTimes(1);
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
