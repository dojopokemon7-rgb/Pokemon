import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * ID-based Pokémon image proxy — GET /api/card-img/<id>.
 *
 * This is the twin of the `?u=` proxy that HIDES the upstream CDN host from
 * the browser: the client requests only a card id, the server resolves the
 * stored `Card.imageUrl` and streams the bytes. These tests mock Prisma + the
 * global fetch so nothing hits the DB or network, and assert:
 *   - a stored scrydex url streams back (image/*),
 *   - `?hi=1` prefers imageUrlHi and falls back to imageUrl,
 *   - unknown id → 404 WITHOUT fetching,
 *   - a stored-but-disallowed-host url → 400 WITHOUT fetching (SSRF
 *     defense-in-depth even though the url came from our own DB),
 *   - non-image upstream / fetch throw degrade gracefully.
 */

// Prisma mock — the route calls findUnique twice (externalId, then id).
const findUnique = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { card: { findUnique: (args: unknown) => findUnique(args) } },
}));

import { GET } from "@/app/api/card-img/[id]/route";

const req = (id: string, hi = false) =>
  new NextRequest(`http://localhost/api/card-img/${id}${hi ? "?hi=1" : ""}`);

const call = (id: string, hi = false) =>
  GET(req(id, hi), { params: Promise.resolve({ id }) });

const imageResponse = (contentType = "image/webp") =>
  new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "Content-Type": contentType },
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => imageResponse());
  vi.stubGlobal("fetch", fetchMock);
  findUnique.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("GET /api/card-img/<id> — happy path", () => {
  it("resolves a stored scrydex url and streams it (200 + cache header)", async () => {
    findUnique.mockResolvedValueOnce({
      imageUrl: "https://images.scrydex.com/pokemon/base1-4/medium",
      imageUrlHi: null,
    });
    const res = await call("base1-4");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=86400, stale-while-revalidate=604800"
    );
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://images.scrydex.com/pokemon/base1-4/medium");
    expect(opts).toMatchObject({ cache: "force-cache", redirect: "manual" });
  });

  it("?hi=1 prefers imageUrlHi", async () => {
    findUnique.mockResolvedValueOnce({
      imageUrl: "https://images.scrydex.com/pokemon/base1-4/medium",
      imageUrlHi: "https://images.scrydex.com/pokemon/base1-4/large",
    });
    await call("base1-4", true);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://images.scrydex.com/pokemon/base1-4/large"
    );
  });

  it("?hi=1 falls back to imageUrl when no hi-res stored", async () => {
    findUnique.mockResolvedValueOnce({
      imageUrl: "https://images.scrydex.com/pokemon/base1-4/medium",
      imageUrlHi: null,
    });
    await call("base1-4", true);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://images.scrydex.com/pokemon/base1-4/medium"
    );
  });

  it("falls back to lookup by internal id when externalId misses", async () => {
    findUnique
      .mockResolvedValueOnce(null) // externalId miss
      .mockResolvedValueOnce({
        imageUrl: "https://images.scrydex.com/pokemon/x/medium",
        imageUrlHi: null,
      });
    const res = await call("ckcuid123");
    expect(res.status).toBe(200);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});

describe("GET /api/card-img/<id> — misses & SSRF", () => {
  it("unknown id → 404 WITHOUT fetching", async () => {
    findUnique.mockResolvedValue(null);
    const res = await call("nope-1");
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("card with no stored image → 404 WITHOUT fetching", async () => {
    findUnique.mockResolvedValueOnce({ imageUrl: null, imageUrlHi: null });
    const res = await call("base1-4");
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stored url on a disallowed host → 400 WITHOUT fetching (defense in depth)", async () => {
    findUnique.mockResolvedValueOnce({
      imageUrl: "https://attacker.com/x.png",
      imageUrlHi: null,
    });
    const res = await call("base1-4");
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stored lookalike-subdomain url → 400 WITHOUT fetching", async () => {
    findUnique.mockResolvedValueOnce({
      imageUrl: "https://images.scrydex.com.evil.com/x.png",
      imageUrlHi: null,
    });
    const res = await call("base1-4");
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stored http (non-https) url → 400 WITHOUT fetching", async () => {
    findUnique.mockResolvedValueOnce({
      imageUrl: "http://images.scrydex.com/x.png",
      imageUrlHi: null,
    });
    const res = await call("base1-4");
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/card-img/<id> — upstream content guard", () => {
  it("non-image upstream content-type → 404", async () => {
    findUnique.mockResolvedValueOnce({
      imageUrl: "https://images.scrydex.com/x",
      imageUrlHi: null,
    });
    fetchMock.mockResolvedValueOnce(
      new Response("<html>nope</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    );
    expect((await call("base1-4")).status).toBe(404);
  });

  it("upstream non-ok → 404", async () => {
    findUnique.mockResolvedValueOnce({
      imageUrl: "https://images.scrydex.com/x",
      imageUrlHi: null,
    });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect((await call("base1-4")).status).toBe(404);
  });

  it("fetch throws → 502", async () => {
    findUnique.mockResolvedValueOnce({
      imageUrl: "https://images.scrydex.com/x",
      imageUrlHi: null,
    });
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    expect((await call("base1-4")).status).toBe(502);
  });
});
