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
 *   - exact-externalId resolves before the case-insensitive fallback (BUG 3,
 *     collision-safe), the insensitive fallback rescues a mis-cased id, and a
 *     composite `::` id resolves its own printing row,
 *   - unknown id → 404 WITHOUT fetching,
 *   - a stored-but-disallowed-host url → 400 WITHOUT fetching (SSRF
 *     defense-in-depth even though the url came from our own DB),
 *   - non-image upstream / fetch throw degrade gracefully.
 */

// Prisma mock — the route now resolves BUG 3 in three steps:
//   1. EXACT externalId  → findUnique({ where: { externalId } })
//   2. case-INSENSITIVE  → findFirst({ where: { externalId: { equals, mode } } })
//   3. internal cuid      → findUnique({ where: { id } })
// `findUnique` serves BOTH the exact-externalId and the cuid lookups, so the
// mock dispatches on the `where` key: a dedicated fn per lookup keeps the
// per-case stubbing readable while asserting the real call order.
const findExternalExact = vi.fn();
const findExternalInsensitive = vi.fn();
const findById = vi.fn();
// `findUnique` receives either { where: { externalId } } (exact) or
// { where: { id } } (cuid); route each to its dedicated stub.
const findUnique = vi.fn((args: { where?: Record<string, unknown> }) =>
  args?.where && "externalId" in args.where ? findExternalExact(args) : findById(args)
);
const findFirst = vi.fn((args: unknown) => findExternalInsensitive(args));
vi.mock("@/lib/db", () => ({
  prisma: {
    card: {
      findFirst: (args: unknown) => findFirst(args),
      findUnique: (args: { where?: Record<string, unknown> }) => findUnique(args),
    },
  },
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
  findFirst.mockClear();
  findUnique.mockClear();
  findExternalExact.mockReset();
  findExternalInsensitive.mockReset();
  findById.mockReset();
  // Default: every lookup misses unless a test opts in. Exact-externalId first,
  // then case-insensitive, then cuid — each returns null so a test stubs only
  // the step it exercises.
  findExternalExact.mockResolvedValue(null);
  findExternalInsensitive.mockResolvedValue(null);
  findById.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("GET /api/card-img/<id> — happy path", () => {
  it("resolves a stored scrydex url and streams it (200 + cache header)", async () => {
    findExternalExact.mockResolvedValueOnce({
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
    // Exact externalId hit short-circuits before the insensitive fallback.
    expect(findExternalExact).toHaveBeenCalledTimes(1);
    expect(findExternalInsensitive).not.toHaveBeenCalled();
  });

  it("?hi=1 prefers imageUrlHi", async () => {
    findExternalExact.mockResolvedValueOnce({
      imageUrl: "https://images.scrydex.com/pokemon/base1-4/medium",
      imageUrlHi: "https://images.scrydex.com/pokemon/base1-4/large",
    });
    await call("base1-4", true);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://images.scrydex.com/pokemon/base1-4/large"
    );
  });

  it("?hi=1 falls back to imageUrl when no hi-res stored", async () => {
    findExternalExact.mockResolvedValueOnce({
      imageUrl: "https://images.scrydex.com/pokemon/base1-4/medium",
      imageUrlHi: null,
    });
    await call("base1-4", true);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://images.scrydex.com/pokemon/base1-4/medium"
    );
  });

  // HARDENING (img-mismatch): ?hi=1 prefers imageUrlHi only when it is the SAME
  // art as imageUrl (size-only difference). When imageUrlHi points at a
  // DIFFERENT art (divergent base-id — the OP01-120 "different Shanks" bug),
  // serve imageUrl so grid and hero agree.
  it("?hi=1 prefers imageUrlHi when it is the same art at a larger size", async () => {
    findExternalExact.mockResolvedValueOnce({
      imageUrl: "https://images.scrydex.com/onepiece/OP01-120A/medium",
      imageUrlHi: "https://images.scrydex.com/onepiece/OP01-120A/large",
    });
    await call("OP01-120", true);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://images.scrydex.com/onepiece/OP01-120A/large"
    );
  });

  it("?hi=1 serves imageUrl when imageUrlHi is a DIFFERENT art (divergent base-id)", async () => {
    findExternalExact.mockResolvedValueOnce({
      imageUrl: "https://images.scrydex.com/onepiece/OP01-120A/large", // correct alt-art
      imageUrlHi: "https://images.scrydex.com/onepiece/OP01-120/large", // WRONG plain base
    });
    await call("OP01-120", true);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://images.scrydex.com/onepiece/OP01-120A/large"
    );
  });

  it("falls back to lookup by internal id when externalId misses", async () => {
    // Both externalId lookups (exact + insensitive) miss → cuid fallback hits.
    findById.mockResolvedValueOnce({
      imageUrl: "https://images.scrydex.com/pokemon/x/medium",
      imageUrlHi: null,
    });
    const res = await call("ckcuid123");
    expect(res.status).toBe(200);
    expect(findExternalExact).toHaveBeenCalledTimes(1);
    expect(findExternalInsensitive).toHaveBeenCalledTimes(1);
    expect(findById).toHaveBeenCalledTimes(1);
    // cuid fallback uses the decoded id as the primary key.
    expect(findById.mock.calls[0][0]).toMatchObject({ where: { id: "ckcuid123" } });
  });

  // BUG 3 — a mis-cased composite id resolves the stored lower-case row via the
  // case-INSENSITIVE fallback (the exact lookup misses on the wrong casing).
  it("resolves case-insensitively: GYM1-1::unlimitedHolofoil → stored gym1-1::unlimitedHolofoil", async () => {
    findExternalExact.mockResolvedValueOnce(null); // exact miss (wrong casing)
    findExternalInsensitive.mockResolvedValueOnce({
      imageUrl: "https://images.scrydex.com/pokemon/gym1-1-unlimited/medium",
      imageUrlHi: null,
    });
    const res = await call("GYM1-1::unlimitedHolofoil");
    expect(res.status).toBe(200);
    // Exact tried first, then matched case-insensitively on the WHOLE decoded
    // composite id (suffix intact).
    expect(findExternalExact).toHaveBeenCalledTimes(1);
    expect(findExternalExact.mock.calls[0][0]).toMatchObject({
      where: { externalId: "GYM1-1::unlimitedHolofoil" },
    });
    expect(findExternalInsensitive).toHaveBeenCalledTimes(1);
    expect(findExternalInsensitive.mock.calls[0][0]).toMatchObject({
      where: { externalId: { equals: "GYM1-1::unlimitedHolofoil", mode: "insensitive" } },
    });
  });

  // BUG 3 (review finding 3) — case-only duplicate rows are POSSIBLE
  // (externalId is case-sensitive @unique). A correctly-cased request must hit
  // its OWN row via the EXACT lookup and NEVER fall through to the ambiguous
  // insensitive match that could return a case-fold sibling.
  it("exact casing hits its own row and never consults the insensitive fallback (collision-safe)", async () => {
    findExternalExact.mockResolvedValueOnce({
      imageUrl: "https://images.scrydex.com/pokemon/gym1-1-exact/medium",
      imageUrlHi: null,
    });
    // If this were consulted it could return the WRONG case-fold sibling.
    findExternalInsensitive.mockResolvedValueOnce({
      imageUrl: "https://images.scrydex.com/pokemon/WRONG-sibling/medium",
      imageUrlHi: null,
    });
    const res = await call("gym1-1::unlimitedHolofoil");
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://images.scrydex.com/pokemon/gym1-1-exact/medium"
    );
    expect(findExternalExact).toHaveBeenCalledTimes(1);
    expect(findExternalInsensitive).not.toHaveBeenCalled();
  });

  // BUG 3 — a composite :: id resolves to ITS OWN row (suffix NOT stripped,
  // not the base card). The lookup key is the full decoded composite id.
  it("a composite :: id looks up its own printing row (suffix not stripped)", async () => {
    findExternalExact.mockResolvedValueOnce({
      imageUrl: "https://images.scrydex.com/pokemon/op01-120-altart/medium",
      imageUrlHi: null,
    });
    // %3A%3A is the URL-encoded "::" the client sends.
    const res = await call("OP01-120%3A%3Aalt-art");
    expect(res.status).toBe(200);
    const lookupKey = findExternalExact.mock.calls[0][0].where.externalId;
    expect(lookupKey).toBe("OP01-120::alt-art"); // decoded, suffix intact
    expect(lookupKey).not.toBe("OP01-120"); // NOT the base id
  });
});

describe("GET /api/card-img/<id> — misses & SSRF", () => {
  it("unknown id → 404 WITHOUT fetching", async () => {
    // All three lookups default to null (beforeEach).
    const res = await call("nope-1");
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404 on miss carries NO Cache-Control (a negative is never cached for a later correct lookup)", async () => {
    const res = await call("nope-1");
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  it("card with no stored image → 404 WITHOUT fetching", async () => {
    findExternalExact.mockResolvedValueOnce({ imageUrl: null, imageUrlHi: null });
    const res = await call("base1-4");
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stored url on a disallowed host → 400 WITHOUT fetching (defense in depth)", async () => {
    findExternalExact.mockResolvedValueOnce({
      imageUrl: "https://attacker.com/x.png",
      imageUrlHi: null,
    });
    const res = await call("base1-4");
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stored lookalike-subdomain url → 400 WITHOUT fetching", async () => {
    findExternalExact.mockResolvedValueOnce({
      imageUrl: "https://images.scrydex.com.evil.com/x.png",
      imageUrlHi: null,
    });
    const res = await call("base1-4");
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stored http (non-https) url → 400 WITHOUT fetching", async () => {
    findExternalExact.mockResolvedValueOnce({
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
    findExternalExact.mockResolvedValueOnce({
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
    findExternalExact.mockResolvedValueOnce({
      imageUrl: "https://images.scrydex.com/x",
      imageUrlHi: null,
    });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect((await call("base1-4")).status).toBe(404);
  });

  it("fetch throws → 502", async () => {
    findExternalExact.mockResolvedValueOnce({
      imageUrl: "https://images.scrydex.com/x",
      imageUrlHi: null,
    });
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    expect((await call("base1-4")).status).toBe(502);
  });
});
