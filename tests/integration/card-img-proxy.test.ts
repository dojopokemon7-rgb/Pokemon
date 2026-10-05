import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/card-img/route";

/**
 * SSRF / open-proxy guard + behaviour for GET /api/card-img?u=…
 *
 * This endpoint fronts Pokémon card CDNs with our same-origin cache. The
 * critical property is that it is NOT an open proxy: only EXACT allowlisted
 * hosts may be fetched, over https, image/* only. These tests mock global
 * fetch so nothing hits the network.
 */

const req = (u?: string) =>
  new NextRequest(
    `http://localhost/api/card-img${u === undefined ? "" : `?u=${encodeURIComponent(u)}`}`
  );

const imageResponse = (contentType = "image/webp") =>
  new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "Content-Type": contentType },
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => imageResponse());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("GET /api/card-img — allowlisted hosts", () => {
  it("proxies an images.scrydex.com url: 200 + cache-control, fetch called", async () => {
    const res = await GET(req("https://images.scrydex.com/pokemon/mee-1/medium"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=86400, stale-while-revalidate=604800"
    );
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // force-cache + manual redirect are the SSRF-safe fetch options.
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://images.scrydex.com/pokemon/mee-1/medium");
    expect(opts).toMatchObject({ cache: "force-cache", redirect: "manual" });
  });

  it("also allows assets.tcgdex.net and images.pokemontcg.io", async () => {
    expect(
      (await GET(req("https://assets.tcgdex.net/en/base/base1/4/high.webp"))).status
    ).toBe(200);
    expect(
      (await GET(req("https://images.pokemontcg.io/base1/4_hires.png"))).status
    ).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/card-img — SSRF / open-proxy guard", () => {
  it("rejects a non-allowlisted host WITHOUT fetching (400)", async () => {
    const res = await GET(req("https://attacker.com/x.png"));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a lookalike subdomain suffix attack WITHOUT fetching (400)", async () => {
    const res = await GET(req("https://images.scrydex.com.evil.com/x.png"));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-https (http) WITHOUT fetching (400)", async () => {
    const res = await GET(req("http://images.scrydex.com/x.png"));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a url carrying credentials WITHOUT fetching (400)", async () => {
    const res = await GET(req("https://user:pass@images.scrydex.com/x.png"));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects missing / malformed u (400)", async () => {
    expect((await GET(req())).status).toBe(400);
    expect((await GET(req("not a url"))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/card-img — upstream content guard", () => {
  it("returns 404 for a non-image upstream content-type (can't proxy arbitrary content)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>nope</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    );
    const res = await GET(req("https://images.scrydex.com/pokemon/mee-1/medium"));
    expect(res.status).toBe(404);
  });

  it("returns 404 on upstream non-ok", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const res = await GET(req("https://images.scrydex.com/pokemon/mee-1/medium"));
    expect(res.status).toBe(404);
  });

  it("returns 502 when the fetch throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const res = await GET(req("https://images.scrydex.com/pokemon/mee-1/medium"));
    expect(res.status).toBe(502);
  });
});
