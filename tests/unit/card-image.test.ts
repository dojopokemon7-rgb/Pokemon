import { describe, it, expect } from "vitest";
import {
  onePieceImageUrl,
  onePieceImageChain,
  isOnePieceCode,
  proxiedCardImage,
  cardImgById,
} from "@/lib/utils/card-image";

/**
 * Guards the One Piece image override — the fix for the "SAMPLE"-watermarked
 * card art (stored TCGplayer placeholder URLs). Valid Bandai codes must route
 * to the same-origin proxy; anything else returns null so the caller keeps
 * its existing image.
 */
describe("onePieceImageUrl", () => {
  it("proxies set-coded cards (OP/ST/EB/PRB)", () => {
    expect(onePieceImageUrl("OP01-001")).toBe("/api/one-piece-img/OP01-001");
    expect(onePieceImageUrl("ST34-001")).toBe("/api/one-piece-img/ST34-001");
    expect(onePieceImageUrl("EB03-035")).toBe("/api/one-piece-img/EB03-035");
    expect(onePieceImageUrl("PRB01-001")).toBe("/api/one-piece-img/PRB01-001");
  });

  it("proxies P-### promos and uppercases the code", () => {
    expect(onePieceImageUrl("P-090")).toBe("/api/one-piece-img/P-090");
    expect(onePieceImageUrl("op11-062")).toBe("/api/one-piece-img/OP11-062");
  });

  it("returns null for non-One-Piece / malformed codes", () => {
    expect(onePieceImageUrl("base1-4")).toBeNull();   // Pokémon
    expect(onePieceImageUrl("sv3-125")).toBeNull();
    expect(onePieceImageUrl("")).toBeNull();
    expect(onePieceImageUrl("OP1-1")).toBeNull();      // wrong digit counts
  });
});

/**
 * Guards the image fallback CHAIN order + de-dup — the UI steps through this
 * on <img onError> (clean stored URL → CDN hi-res → Bandai proxy).
 */
describe("onePieceImageChain", () => {
  it("orders stored → hi-res → Bandai proxy, drops empties, de-dupes", () => {
    expect(
      onePieceImageChain(
        "OP01-001",
        "https://clean.example/OP01-001.png",
        "https://tcgplayer-cdn.tcgplayer.com/hi.jpg"
      )
    ).toEqual([
      "https://clean.example/OP01-001.png",
      "https://tcgplayer-cdn.tcgplayer.com/hi.jpg",
      "/api/one-piece-img/OP01-001",
    ]);

    // Same URL in stored + hi-res collapses to one entry (still + proxy).
    expect(onePieceImageChain("OP01-001", "https://x/a.png", "https://x/a.png")).toEqual([
      "https://x/a.png",
      "/api/one-piece-img/OP01-001",
    ]);

    // No stored image → just the Bandai proxy.
    expect(onePieceImageChain("OP01-001", null, null)).toEqual(["/api/one-piece-img/OP01-001"]);

    // Non-One-Piece code → only whatever real URLs were passed (no proxy).
    expect(onePieceImageChain("base1-4", "https://img/x.png")).toEqual(["https://img/x.png"]);
  });

  it("isOnePieceCode recognises Bandai codes", () => {
    expect(isOnePieceCode("op01-001")).toBe(true);
    expect(isOnePieceCode("P-025")).toBe(true);
    expect(isOnePieceCode("base1-4")).toBe(false);
  });
});

/**
 * Guards the anti-hotlink proxy helper: only allowlisted Pokémon CDN URLs are
 * rewritten to the same-origin /api/card-img proxy; everything else (null, One
 * Piece proxy chain, same-origin, other hosts) passes through UNCHANGED so the
 * helper is safe at a game-agnostic chokepoint.
 */
describe("proxiedCardImage", () => {
  it("proxies allowlisted Pokémon CDN hosts", () => {
    expect(proxiedCardImage("https://images.scrydex.com/pokemon/mee-1/medium")).toBe(
      "/api/card-img?u=" +
        encodeURIComponent("https://images.scrydex.com/pokemon/mee-1/medium")
    );
    expect(proxiedCardImage("https://assets.tcgdex.net/en/base/base1/4/high.webp")).toBe(
      "/api/card-img?u=" +
        encodeURIComponent("https://assets.tcgdex.net/en/base/base1/4/high.webp")
    );
    expect(proxiedCardImage("https://images.pokemontcg.io/base1/4_hires.png")).toBe(
      "/api/card-img?u=" +
        encodeURIComponent("https://images.pokemontcg.io/base1/4_hires.png")
    );
  });

  it("passes through null / empty unchanged", () => {
    expect(proxiedCardImage(null)).toBeNull();
    expect(proxiedCardImage(undefined)).toBeNull();
    expect(proxiedCardImage("")).toBeNull();
  });

  it("passes through the One Piece proxy + same-origin URLs unchanged (no double-proxy)", () => {
    expect(proxiedCardImage("/api/one-piece-img/OP01-001")).toBe(
      "/api/one-piece-img/OP01-001"
    );
    expect(proxiedCardImage("/local/x.png")).toBe("/local/x.png");
  });

  it("passes through non-allowlisted + non-https hosts unchanged (no SSRF via helper)", () => {
    expect(proxiedCardImage("https://tcgplayer-cdn.tcgplayer.com/hi.jpg")).toBe(
      "https://tcgplayer-cdn.tcgplayer.com/hi.jpg"
    );
    expect(proxiedCardImage("https://images.scrydex.com.evil.com/x")).toBe(
      "https://images.scrydex.com.evil.com/x"
    );
    expect(proxiedCardImage("http://images.scrydex.com/x")).toBe(
      "http://images.scrydex.com/x"
    );
  });
});

/**
 * Guards the id-based proxy helper: the browser-facing src is `/api/card-img/
 * <id>` (same-origin), NOT a `?u=<upstream url>` that would leak the CDN host.
 */
describe("cardImgById", () => {
  it("builds the same-origin id-based proxy url (not ?u=...)", () => {
    const src = cardImgById("base1-4");
    expect(src).toBe("/api/card-img/base1-4");
    expect(src).not.toContain("?u=");
    expect(src).not.toContain("scrydex");
  });

  it("appends ?hi=1 only when hi-res is requested", () => {
    expect(cardImgById("base1-4", false)).toBe("/api/card-img/base1-4");
    expect(cardImgById("base1-4", true)).toBe("/api/card-img/base1-4?hi=1");
  });

  it("url-encodes the id", () => {
    expect(cardImgById("sv3pt5-199/ foo")).toBe(
      "/api/card-img/" + encodeURIComponent("sv3pt5-199/ foo")
    );
  });
});
