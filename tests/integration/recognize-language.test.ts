import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * FEAT-002 — optional `language` on POST /api/cards/recognize.
 * Everything external is MOCKED: no live DB, no Scrydex credits
 * (isScrydexLiveApproved -> false, identifyCard is a spy that must never run).
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

vi.mock("@/lib/services/scan-allowance.service", () => ({
  getScanAllowance: vi.fn(async () => ({ used: 0, limit: 10, remaining: 10 })),
  reserveSuccessfulScan: vi.fn(),
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
  scrydex.approved.mockResolvedValue(false);
  authMock.getSession.mockResolvedValue({ user: { id: "user_1" } });
  prismaMock.card.findMany.mockResolvedValue([
    { externalId: "base1-4", name: "Charizard", number: "4", imageUrl: "", imageUrlHi: null, set: { name: "Base" } },
  ]);
  prismaMock.scanFeedback.create.mockResolvedValue({ id: "fb_1" });
});

describe("POST /api/cards/recognize language", () => {
  it("old body without language still works; language echoes as all", async () => {
    const res = await POST(req({ text: "Charizard 4", game: "pokemon", source: "manual" }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.ocrSource).toBe("manual");
    expect(data.candidates[0].id).toBe("base1-4");
    expect(data.language).toBe("all");
    expect(data.languageApplied).toBe(false);
  });

  it.each(["en", "ja"])("accepts %s on the text path and reports it was not applied", async (language) => {
    const res = await POST(req({ text: "Charizard 4", language }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.language).toBe(language);
    expect(data.languageApplied).toBe(false);
    expect(JSON.stringify(data)).not.toMatch(/ocrLanguage|restricted/i);
  });

  it("rejects an invalid language with 400 invalid-language", async () => {
    const res = await POST(req({ text: "Charizard", language: "fr" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: "invalid-language" });
    const res2 = await POST(req({ image: JPEG_B64, language: 5 }));
    expect(res2.status).toBe(400);
  });

  it("image path with the credit gate denied still returns scan-pending-approval and spends nothing", async () => {
    const spy = vi.spyOn(console, "log");
    const res = await POST(req({ image: JPEG_B64, language: "ja" }));
    const data = await res.json();
    expect(data.error).toBe("scan-pending-approval");
    expect(scrydex.identifyCard).not.toHaveBeenCalled();
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(JPEG_B64);
    spy.mockRestore();
  });
});
