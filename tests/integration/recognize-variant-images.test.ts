import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Phase 2 — POST /api/cards/recognize must attach a One Piece card's
 * `variantImages` map (base + alt-arts) to the OCR-exact candidate so the
 * client can run the on-device CLIP visual variant match. Verifies:
 *   (a) a One Piece exact OCR code match with MORE THAN ONE distinct variant
 *       image returns the candidate carrying `variantImages`, appearing EXACTLY
 *       ONCE (dedupe — not N tiles for the same card);
 *   (b) a card with a single image (one-entry map) carries NO multi-variant
 *       payload (variantImages === null) so the client no-ops the visual step;
 *   (c) the response shape stays backward-compatible (existing fields intact).
 *
 * Everything external is MOCKED: no live DB, no network, no Scrydex credits.
 */

const prismaMock = vi.hoisted(() => ({
  card: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
  scanFeedback: { create: vi.fn(), update: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

const authMock = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: authMock.getSession } } }));

const scrydex = vi.hoisted(() => ({ identifyCard: vi.fn(), approved: vi.fn() }));
vi.mock("@/lib/services/scrydex.service", () => ({ identifyCard: scrydex.identifyCard }));
vi.mock("@/lib/services/scrydex-credit-gate", () => ({ isScrydexLiveApproved: scrydex.approved }));

vi.mock("@/lib/services/scan-allowance.service", () => ({
  getScanAllowance: vi.fn(async () => ({ used: 0, limit: 10, remaining: 10 })),
  reserveSuccessfulScan: vi.fn(),
}));

import { POST } from "@/app/api/cards/recognize/route";

function req(body: unknown) {
  return new Request("http://localhost/api/cards/recognize", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// Real-shaped OP08-023 variant map: base green + 3 distinct alt arts.
const OP08_VARIANTS = {
  normal: { large: "https://images.scrydex.com/op08-023/base.png" },
  alt_art: { large: "https://images.scrydex.com/op08-023/alt.png" },
  manga: { large: "https://images.scrydex.com/op08-023/manga.png" },
  parallel: { large: "https://images.scrydex.com/op08-023/parallel.png" },
};

beforeEach(() => {
  vi.clearAllMocks();
  authMock.getSession.mockResolvedValue({ user: { id: "user_1" } });
  prismaMock.scanFeedback.create.mockResolvedValue({ id: "fb_1" });
  // Keep the fuzzy pool empty so the exact candidate is the only tile.
  prismaMock.card.findMany.mockResolvedValue([]);
});

describe("POST /api/cards/recognize — One Piece variantImages (Phase 2)", () => {
  it("attaches variantImages to a One Piece exact match with >1 distinct art, once", async () => {
    prismaMock.card.findFirst.mockResolvedValue({
      externalId: "OP08-023",
      name: "Carrot",
      number: "OP08-023",
      imageUrl: "/api/one-piece-img/OP08-023",
      imageUrlHi: null,
      variantImages: OP08_VARIANTS,
      set: { name: "Two Legends [OP-08]", externalId: "onepiece-op08" },
    });

    const res = await POST(req({ text: "OP08-023 Carrot", game: "onepiece", source: "tesseract" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);

    // The matched card appears EXACTLY ONCE (dedupe — not 4 separate tiles).
    const op08 = data.candidates.filter((c: { id: string }) => c.id === "OP08-023");
    expect(op08).toHaveLength(1);

    const top = data.candidates[0];
    expect(top.id).toBe("OP08-023");
    expect(top.confidence).toBe(1);
    // Backward-compatible fields intact.
    expect(top.imageUrl).toBe("/api/one-piece-img/OP08-023");
    // Phase 2: the real variant map rides along (base + 3 alt arts).
    expect(top.variantImages).toEqual(OP08_VARIANTS);
  });

  it("omits variantImages (null) for a single-image card so the client no-ops the visual step", async () => {
    prismaMock.card.findFirst.mockResolvedValue({
      externalId: "OP08-099",
      name: "Single Art",
      number: "OP08-099",
      imageUrl: "/api/one-piece-img/OP08-099",
      imageUrlHi: null,
      variantImages: { normal: { large: "https://images.scrydex.com/op08-099/base.png" } },
      set: { name: "Two Legends [OP-08]", externalId: "onepiece-op08" },
    });

    const res = await POST(req({ text: "OP08-099", game: "onepiece", source: "tesseract" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    const top = data.candidates[0];
    expect(top.id).toBe("OP08-099");
    expect(top.variantImages ?? null).toBeNull();
  });
});
