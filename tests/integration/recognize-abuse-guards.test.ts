import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Phase 2 remediation — abuse guards on POST /api/cards/recognize.
 *
 * C-1 (request-size): an oversized body is rejected with HTTP 413 BEFORE
 *   request.json()/base64ToBytes/the scorer run — proven by spying on the
 *   decode + DB entry points and asserting they are never reached. A valid
 *   small image still 200s end-to-end (decode IS reached).
 *
 * C-2 (anonymous text abuse): anonymous `text` requests over the IP limit →
 *   429 (the limiter is wired, NOT mocked-allow — we drive the Redis INCR
 *   reply); text over MAX_RECOGNIZE_TEXT_CHARS → 400 BEFORE the catalog
 *   findMany; both guards precede the pool query (asserted: findMany/create
 *   not called when limited or oversized). The anonymous ScanFeedback write
 *   is KEPT but only runs after the IP limit gates the request (documented
 *   choice) — asserted by observing the write on an allowed anonymous call.
 *
 * Everything external is MOCKED (no live DB, Redis, network, or Scrydex).
 */

// --- base64ToBytes spy: proves the decode path is / isn't reached ------------
const scanUpload = vi.hoisted(() => ({
  base64ToBytes: vi.fn(),
  validateScanUpload: vi.fn(),
}));
vi.mock("@/lib/utils/scan-upload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils/scan-upload")>();
  return {
    ...actual, // keep the REAL MAX_SCAN_BYTES so the route's cap math is production-accurate
    base64ToBytes: scanUpload.base64ToBytes,
    validateScanUpload: scanUpload.validateScanUpload,
  };
});

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

const allowance = vi.hoisted(() => ({ reserve: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/services/scan-allowance.service", () => ({
  getScanAllowance: allowance.get,
  reserveSuccessfulScan: allowance.reserve,
}));

// Redis mock: a chainable multi() whose INCR reply we control, so the limiter
// genuinely enforces (not a mocked-allow). The REAL RedisKeys registry stays.
const redisState = vi.hoisted(() => ({ incrReply: 1 as number | Error }));
const redisMock = vi.hoisted(() => {
  const state = redisState;
  const multi = vi.fn(() => {
    const chain = {
      incr: vi.fn(() => chain),
      expire: vi.fn(() => chain),
      exec: vi.fn(async () => {
        if (state.incrReply instanceof Error) throw state.incrReply;
        return [[null, state.incrReply]];
      }),
    };
    return chain;
  });
  return { multi, ttl: vi.fn(async () => 60) };
});
vi.mock("@/lib/redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/redis")>();
  return { ...actual, redis: redisMock };
});

import { POST } from "@/app/api/cards/recognize/route";
import { MAX_SCAN_BYTES } from "@/lib/utils/scan-upload";

function req(body: unknown): Request {
  return new Request("http://localhost/api/cards/recognize", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  redisState.incrReply = 1; // allow by default
  scrydex.approved.mockResolvedValue(true);
  authMock.getSession.mockResolvedValue(null); // anonymous unless a test overrides
  allowance.get.mockResolvedValue({ used: 0, limit: 10, remaining: 10 });
  allowance.reserve.mockResolvedValue({ ok: true, allowance: { used: 1, limit: 10, remaining: 9 } });
  prismaMock.card.findMany.mockResolvedValue([]);
  prismaMock.scanFeedback.create.mockResolvedValue({ id: "fb_1" });
  // A real-shaped validation so the valid-image path can proceed if reached.
  scanUpload.base64ToBytes.mockReturnValue(new Uint8Array([0xff, 0xd8, 0xff]));
  scanUpload.validateScanUpload.mockReturnValue({ ok: true, mime: "image/jpeg" });
});

// MAX_REQUEST_BYTES in the route = ceil(MAX_SCAN_BYTES*4/3) + 1MB (~28MB).
const MAX_REQUEST_BYTES = Math.ceil((MAX_SCAN_BYTES * 4) / 3) + 1024 * 1024;

describe("C-1 — request-size protection (413 before parse/decode)", () => {
  it("rejects an oversized body (honest large Content-Length) with 413 and never decodes", async () => {
    // Build a body whose actual size exceeds the cap.
    const huge = "A".repeat(MAX_REQUEST_BYTES + 1000);
    const r = new Request("http://localhost/api/cards/recognize", {
      method: "POST",
      body: JSON.stringify({ image: huge }),
    });

    const res = await POST(r);

    expect(res.status).toBe(413);
    const data = await res.json();
    expect(data.error).toBe("request-too-large");
    // Proven: the body was never JSON-parsed into a usable image, so neither the
    // base64 decode nor the scorer/DB path was reached.
    expect(scanUpload.base64ToBytes).not.toHaveBeenCalled();
    expect(scanUpload.validateScanUpload).not.toHaveBeenCalled();
    expect(prismaMock.card.findMany).not.toHaveBeenCalled();
    expect(prismaMock.card.findFirst).not.toHaveBeenCalled();
  });

  it("rejects an oversized body even with a MISSING/LYING Content-Length (stream-counted) with 413", async () => {
    // Construct a Request whose body stream yields more than the cap while the
    // Content-Length header is absent (undici does not set it for a stream body).
    const chunk = new Uint8Array(1024 * 1024).fill(0x41); // 1MB of 'A'
    const chunksNeeded = Math.ceil(MAX_REQUEST_BYTES / chunk.byteLength) + 2;
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= chunksNeeded) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        sent++;
      },
    });
    const r = new Request("http://localhost/api/cards/recognize", {
      method: "POST",
      body: stream,
      // No content-length set; undici marks this a duplex stream.
      // @ts-expect-error duplex is required by undici for a stream body
      duplex: "half",
    });
    // Ensure the header really is absent (don't rely on a lie, prove the stream guard).
    expect(r.headers.get("content-length")).toBeNull();

    const res = await POST(r);

    expect(res.status).toBe(413);
    expect(scanUpload.base64ToBytes).not.toHaveBeenCalled();
    expect(prismaMock.card.findMany).not.toHaveBeenCalled();
  });

  it("a valid small image still works end-to-end (decode IS reached, 200)", async () => {
    authMock.getSession.mockResolvedValue({ user: { id: "user_1" } }); // image path needs a session
    scrydex.identifyCard.mockResolvedValue([{ cardId: "base1-4", score: 0.9 }]);
    prismaMock.card.findMany.mockResolvedValue([
      {
        externalId: "base1-4",
        name: "Charizard",
        number: "4/102",
        imageUrl: "https://img/charizard.png",
        imageUrlHi: null,
        variantImages: null,
        set: { name: "Base Set", externalId: "pokemon-base1" },
      },
    ]);

    const res = await POST(req({ image: "ZmFrZS1pbWFnZQ==", game: "pokemon" }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.candidates[0].id).toBe("base1-4");
    // The decode path WAS reached (the cap allowed a legitimate small body).
    expect(scanUpload.base64ToBytes).toHaveBeenCalledTimes(1);
    expect(scanUpload.validateScanUpload).toHaveBeenCalledTimes(1);
  });
});

describe("C-2 — anonymous text abuse (IP rate limit + length cap)", () => {
  it("anonymous text over the IP limit → 429 BEFORE the catalog findMany/write", async () => {
    redisState.incrReply = 61; // searchTier default is 60/min → 61 is over
    const res = await POST(req({ text: "charizard holo", game: "pokemon", source: "tesseract" }));

    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.error).toBe("Too Many Requests");
    // The limit ran BEFORE the expensive catalog query and the anonymous write.
    expect(prismaMock.card.findMany).not.toHaveBeenCalled();
    expect(prismaMock.card.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.scanFeedback.create).not.toHaveBeenCalled();
  });

  it("text over MAX_RECOGNIZE_TEXT_CHARS → 400 BEFORE the catalog findMany/write", async () => {
    redisState.incrReply = 1; // under the limit — isolate the length cap
    const longText = "x".repeat(5000); // > 4096 cap
    const res = await POST(req({ text: longText, game: "pokemon", source: "tesseract" }));

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("text-too-long");
    expect(prismaMock.card.findMany).not.toHaveBeenCalled();
    expect(prismaMock.card.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.scanFeedback.create).not.toHaveBeenCalled();
  });

  it("an allowed anonymous text request still runs the pool query and KEEPS the ScanFeedback write", async () => {
    redisState.incrReply = 1; // under the limit
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

    const res = await POST(req({ text: "charizard", game: "pokemon", source: "tesseract" }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    // Documented choice: the anonymous write is KEPT (gated behind the IP limit).
    expect(prismaMock.card.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.scanFeedback.create).toHaveBeenCalledTimes(1);
    const writeArgs = prismaMock.scanFeedback.create.mock.calls[0][0];
    expect(writeArgs.data.userId).toBeNull(); // anonymous row, userId null
    expect(data.feedbackId).toBe("fb_1");
  });
});
