import { describe, it, expect } from "vitest";
import { onePieceImageUrl, onePieceImageChain, isOnePieceCode } from "@/lib/utils/card-image";

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
