import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * GET/POST /api/cron/refresh-owned-prices — CRON_SECRET auth gate.
 *
 * Pins the FAIL-CLOSED auth contract (prior security finding — must NOT
 * regress) against a mocked service so NO real refresh runs:
 *   (a) CRON_SECRET set + missing secret → 401, service NOT called;
 *   (b) wrong secret → 401;
 *   (c) correct Bearer → 200 {ok:true, summary}, service called once;
 *   (d) ?secret= query variant → 200;
 *   (e) CRON_SECRET UNSET + NODE_ENV=production → 401 (fail-closed);
 *   (f) CRON_SECRET UNSET + non-production → allowed (local-dev pass-through).
 */

const serviceMock = vi.hoisted(() => ({ refreshOwnedPrices: vi.fn() }));
vi.mock("@/lib/services/owned-price-refresh.service", () => serviceMock);

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/cron/refresh-owned-prices/route";

const SECRET = "s3cr3t";
const SUMMARY = {
  owned: 2,
  attempted: 2,
  refreshed: 1,
  skipped: 1,
  failed: 0,
  credits: 1,
};

function req(opts?: { bearer?: string; query?: string }) {
  const url = `http://localhost/api/cron/refresh-owned-prices${
    opts?.query ? `?secret=${opts.query}` : ""
  }`;
  const headers: Record<string, string> = {};
  if (opts?.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  // NextRequest wraps a standard Request; the route reads nextUrl.searchParams
  // + headers, both backed by the URL/Headers below.
  return new NextRequest(url, { headers });
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  serviceMock.refreshOwnedPrices.mockResolvedValue(SUMMARY);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /api/cron/refresh-owned-prices auth", () => {
  it("(a) secret set, no secret supplied → 401, service not called", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(serviceMock.refreshOwnedPrices).not.toHaveBeenCalled();
  });

  it("(b) wrong secret → 401", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await GET(req({ bearer: "nope" }));
    expect(res.status).toBe(401);
    expect(serviceMock.refreshOwnedPrices).not.toHaveBeenCalled();
  });

  it("(c) correct Bearer → 200 {ok:true, summary}, service called once", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await GET(req({ bearer: SECRET }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, summary: SUMMARY });
    expect(serviceMock.refreshOwnedPrices).toHaveBeenCalledTimes(1);
  });

  it("(d) ?secret= query variant → 200", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await GET(req({ query: SECRET }));
    expect(res.status).toBe(200);
    expect(serviceMock.refreshOwnedPrices).toHaveBeenCalledTimes(1);
  });

  it("(e) CRON_SECRET unset + NODE_ENV=production → 401 (fail-closed)", async () => {
    delete process.env.CRON_SECRET;
    vi.stubEnv("NODE_ENV", "production");
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(serviceMock.refreshOwnedPrices).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("(f) CRON_SECRET unset + non-production → allowed (local-dev pass-through)", async () => {
    delete process.env.CRON_SECRET;
    vi.stubEnv("NODE_ENV", "development");
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(serviceMock.refreshOwnedPrices).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });
});

describe("POST /api/cron/refresh-owned-prices", () => {
  it("POST reaches the same handler (correct Bearer → 200)", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await POST(req({ bearer: SECRET }));
    expect(res.status).toBe(200);
    expect(serviceMock.refreshOwnedPrices).toHaveBeenCalledTimes(1);
  });
});
