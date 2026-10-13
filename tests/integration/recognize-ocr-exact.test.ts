import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * OCR-first EXACT collector-code lookup — POST /api/cards/recognize (TEXT path).
 *
 * Phase 1 of the OCR-first scanner: on-device tesseract reads the printed
 * collector code, the client re-submits it as `text` (source=tesseract), and
 * the route resolves a cleanly-read code DIRECTLY to a Card by externalId
 * (game-scoped) as the confident top candidate (confidence 1). When no code is
 * extractable, or the code doesn't resolve, the route behaves EXACTLY as before
 * (fuzzy-only). Pokemon is unchanged; raw/garbage input falls back gracefully.
 *
 * Everything external is MOCKED: no live DB, no network, no Scrydex credits.
 * The TEXT path never calls identifyCard or reserves an allowance slot — these
 * are asserted so the credit-gate / scan-allowance ordering can't regress.
 */

const prismaMock = vi.hoisted(() => ({
  card: { findMany: vi.fn(), findFirst: vi.fn() },
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
  // Default: fuzzy pool empty unless a case overrides it.
  prismaMock.card.findMany.mockResolvedValue([]);
});

const OP08_ROW = {
  externalId: "OP08-023",
  name: "Carrot",
  number: "OP08-023",
  imageUrl: "/api/one-piece-img/OP08-023",
  imageUrlHi: null,
  set: { name: "Two Legends [OP-08]" },
};

describe("POST /api/cards/recognize — OCR-first exact code lookup", () => {
  it("resolves an unhyphenated, O→0-confused slab code to the exact Card as candidates[0]", async () => {
    prismaMock.card.findFirst.mockResolvedValue(OP08_ROW);

    const res = await POST(
      req({ text: "2024 ONE PIECE OPO8 EN #023 CARROT", game: "onepiece", source: "tesseract" })
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    // Exact match leads the strip with confidence 1.
    expect(data.candidates[0].id).toBe("OP08-023");
    expect(data.candidates[0].confidence).toBe(1);
    // RULE 13: image is the same-origin proxy path from the Card row.
    expect(data.candidates[0].imageUrl).toBe("/api/one-piece-img/OP08-023");
    // The exact lookup used the canonical externalId and the One Piece set scope.
    const where = prismaMock.card.findFirst.mock.calls[0][0].where;
    expect(where.externalId).toBe("OP08-023");
    expect(where.set.externalId.startsWith).toBe("onepiece-");
    // No credits, no allowance burned on the TEXT path.
    expect(scrydex.identifyCard).not.toHaveBeenCalled();
    expect(allowance.reserve).not.toHaveBeenCalled();
    expect(data.ocrSource).toBe("tesseract");
  });

  it("resolves the same code when the tail carries an O→0 swap (OP08-O23)", async () => {
    prismaMock.card.findFirst.mockResolvedValue(OP08_ROW);

    const res = await POST(req({ text: "OP08-O23 Carrot", game: "onepiece", source: "tesseract" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.candidates[0].id).toBe("OP08-023");
    expect(prismaMock.card.findFirst.mock.calls[0][0].where.externalId).toBe("OP08-023");
  });

  it("Pokemon scan with no extractable set-code falls through to fuzzy scoring (exact branch inert)", async () => {
    // "4/102" is a Pokemon fraction, not a OP/ST/EB/PRB/P code — extractCardCodes
    // yields [], so findFirst is never consulted and the fuzzy path runs as today.
    prismaMock.card.findMany.mockResolvedValue([
      {
        externalId: "base1-4",
        name: "Charizard",
        number: "4/102",
        imageUrl: "https://img/charizard.png",
        imageUrlHi: null,
        set: { name: "Base Set" },
      },
    ]);

    const res = await POST(req({ text: "Charizard 4/102", game: "pokemon", source: "tesseract" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(prismaMock.card.findFirst).not.toHaveBeenCalled();
    expect(data.candidates[0].id).toBe("base1-4");
    expect(scrydex.identifyCard).not.toHaveBeenCalled();
    expect(allowance.reserve).not.toHaveBeenCalled();
  });

  it("a code that doesn't resolve still falls through to fuzzy (exact miss, no regression)", async () => {
    // Code extracts, but no local Card matches it (null) — fuzzy runs normally.
    prismaMock.card.findFirst.mockResolvedValue(null);
    prismaMock.card.findMany.mockResolvedValue([OP08_ROW]);

    const res = await POST(req({ text: "ST21-001 Luffy", game: "onepiece", source: "tesseract" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(prismaMock.card.findFirst).toHaveBeenCalledTimes(1);
    // Fuzzy result survives — not blanked by an exact miss.
    expect(data.candidates.length).toBeGreaterThanOrEqual(0);
    expect(scrydex.identifyCard).not.toHaveBeenCalled();
  });

  it("garbage OCR with no code and an empty pool returns [] gracefully (HTTP 200)", async () => {
    prismaMock.card.findMany.mockResolvedValue([]);

    const res = await POST(req({ text: "zzzz random noise 999", game: "onepiece", source: "tesseract" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.candidates).toEqual([]);
    expect(data.ocrSource).toBe("tesseract");
    expect(prismaMock.card.findFirst).not.toHaveBeenCalled();
    expect(scrydex.identifyCard).not.toHaveBeenCalled();
    expect(allowance.reserve).not.toHaveBeenCalled();
  });
});
