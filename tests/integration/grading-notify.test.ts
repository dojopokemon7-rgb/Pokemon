import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Prisma } from "@prisma/client";

/**
 * POST /api/grading/notify — public landing form backend. Prisma + rate limiter
 * mocked (no DB/Redis). Asserts the Worker-compatible contract, hardening, and
 * that no response/log ever echoes the email.
 */
const db = vi.hoisted(() => ({ gradingInterest: { upsert: vi.fn(), update: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: db }));
const limiter = vi.hoisted(() => ({ enforceRateLimit: vi.fn() }));
vi.mock("@/lib/utils/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/utils/rate-limit")>()),
  enforceRateLimit: limiter.enforceRateLimit,
}));

import { POST, GET, PUT } from "@/app/api/grading/notify/route";

const URL_ = "http://localhost/api/grading/notify";
const good = { email: "  Ash@Example.COM ", category: "cards", volume: "1-10", source: "grading-page" };
const post = (body: unknown, headers: Record<string, string> = {}, raw?: string) =>
  new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw ?? JSON.stringify(body),
  });

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  limiter.enforceRateLimit.mockResolvedValue(null);
  db.gradingInterest.upsert.mockResolvedValue({});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe("success", () => {
  it("returns { ok:true, returning:false } and writes lowercased+trimmed email", async () => {
    const res = await POST(post(good));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, returning: false });
    const arg = db.gradingInterest.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ email: "ash@example.com" });
    expect(arg.create).toMatchObject({ email: "ash@example.com", category: "cards", volume: "1-10", source: "grading-page" });
    expect(arg.update.updatedAt).toBeInstanceOf(Date);
  });

  it("new vs existing address -> byte-identical response (no enumeration)", async () => {
    const a = await POST(post(good));
    db.gradingInterest.upsert.mockResolvedValue({ updatedAt: new Date() }); // existing row
    const b = await POST(post(good));
    expect(b.status).toBe(a.status);
    expect(await b.text()).toBe(await a.text());
  });

  it("P2002 race -> retried as an update, still success", async () => {
    db.gradingInterest.upsert.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" })
    );
    db.gradingInterest.update.mockResolvedValue({});
    const res = await POST(post(good));
    expect(res.status).toBe(200);
    expect(db.gradingInterest.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "ash@example.com" } })
    );
  });

  it("source is optional and truncated to 40 chars; unknown keys ignored", async () => {
    await POST(post({ ...good, source: "x".repeat(100), admin: true }));
    expect(db.gradingInterest.upsert.mock.calls[0][0].create.source).toBe("x".repeat(40));
    await POST(post({ ...good, source: undefined }));
    expect(db.gradingInterest.upsert.mock.calls[1][0].create.source).toBeNull();
  });
});

describe("validation -> Worker-compatible 400", () => {
  it.each([
    [{ ...good, email: "nope" }, "That email doesn’t look right."],
    [{ ...good, email: `${"a".repeat(250)}@b.co` }, "That email doesn’t look right."],
    [{ ...good, email: 42 }, "That email doesn’t look right."],
    [{ ...good, category: "toys" }, "Pick what you’d send."],
    [{ ...good, volume: "9000" }, "Pick roughly how many."],
    [{ ...good, category: undefined }, "Pick what you’d send."],
  ])("%j", async (body, msg) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: msg });
    expect(db.gradingInterest.upsert).not.toHaveBeenCalled();
  });

  it.each(["{not json", "null", "[]"])("bad body %s -> 400", async (raw) => {
    const res = await POST(post(null, {}, raw));
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe("string");
  });
});

describe("method / content-type / size / origin / rate limit", () => {
  it("non-POST -> 405 { error: 'Use POST.' } + Allow", async () => {
    for (const h of [GET, PUT]) {
      const res = await h();
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
      expect(await res.json()).toEqual({ error: "Use POST." });
    }
  });

  it("non-JSON content-type -> 415, nothing written", async () => {
    const res = await POST(post(good, { "content-type": "text/plain" }));
    expect(res.status).toBe(415);
    expect(db.gradingInterest.upsert).not.toHaveBeenCalled();
  });

  it("oversized body -> 413 before parsing (content-length and streamed)", async () => {
    const big = JSON.stringify({ ...good, pad: "x".repeat(5000) });
    const spy = vi.spyOn(JSON, "parse");
    const a = await POST(post(null, { "content-length": String(big.length) }, big));
    expect(a.status).toBe(413);
    const b = await POST(post(null, { "content-length": "10" }, big)); // lying header
    expect(b.status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(db.gradingInterest.upsert).not.toHaveBeenCalled();
  });

  it("rate limited -> 429 with Retry-After, before any DB write", async () => {
    limiter.enforceRateLimit.mockResolvedValue(
      new Response("{}", { status: 429, headers: { "Retry-After": "42" } })
    );
    const res = await POST(post(good));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(typeof (await res.json()).error).toBe("string");
    expect(db.gradingInterest.upsert).not.toHaveBeenCalled();
  });

  it("cross-origin Origin -> 403; same-origin Origin allowed", async () => {
    expect((await POST(post(good, { origin: "https://evil.example", host: "localhost" }))).status).toBe(403);
    expect((await POST(post(good, { origin: "http://localhost", host: "localhost" }))).status).toBe(200);
  });
});

describe("server errors", () => {
  it("missing table (P2021) -> Worker 500 shape, loud log WITHOUT the email, no crash", async () => {
    db.gradingInterest.upsert.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        "The table `public.grading_interest` does not exist (ash@example.com)",
        { code: "P2021", clientVersion: "x" }
      )
    );
    const res = await POST(post(good));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not save that right now." });
    const logged = JSON.stringify(errSpy.mock.calls);
    expect(logged).toContain("grading_interest");
    expect(logged.toLowerCase()).not.toContain("ash@example.com");
  });

  it("other DB failure -> same 500 shape, code-only log", async () => {
    db.gradingInterest.upsert.mockRejectedValue(new Error("boom ash@example.com"));
    const res = await POST(post(good));
    expect(res.status).toBe(500);
    expect(JSON.stringify(errSpy.mock.calls).toLowerCase()).not.toContain("ash@example.com");
  });
});
