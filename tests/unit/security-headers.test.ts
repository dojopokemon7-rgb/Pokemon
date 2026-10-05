import { describe, it, expect } from "vitest";
import nextConfig from "../../next.config";

// Guards sec-audit-3 Finding #1 (HIGH): the app must ship application
// security headers on every response. This asserts next.config's headers()
// emits a global `/:path*` entry carrying each required header, so a future
// edit can't silently drop them. (A real CSP block check needs a browser;
// the CSP ships Report-Only — see the comment in next.config.ts.)
describe("next.config security headers", () => {
  it("emits the global security-headers entry on /:path*", async () => {
    expect(typeof nextConfig.headers).toBe("function");
    const entries = await nextConfig.headers!();

    const global = entries.find((e) => e.source === "/:path*");
    expect(global, "a /:path* headers entry must exist").toBeDefined();

    const keys = new Set(global!.headers.map((h) => h.key));
    for (const required of [
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
      "Strict-Transport-Security",
      "Permissions-Policy",
      "Content-Security-Policy-Report-Only",
    ]) {
      expect(keys.has(required), `missing ${required}`).toBe(true);
    }

    // The existing PWA cache entries must survive alongside the new block.
    expect(entries.some((e) => e.source === "/sw.js")).toBe(true);
    expect(entries.some((e) => e.source === "/manifest.json")).toBe(true);
  });

  it("CSP covers every image origin the browser loads card art from", async () => {
    const entries = await nextConfig.headers!();
    const global = entries.find((e) => e.source === "/:path*")!;
    const csp = global.headers.find(
      (h) => h.key === "Content-Security-Policy-Report-Only"
    )!.value;

    // Pokémon CDNs (must match /api/card-img allowlist) + One Piece upstreams
    // the <img> loads directly + the Supabase storage host.
    for (const host of [
      "images.scrydex.com",
      "assets.tcgdex.net",
      "images.pokemontcg.io",
      "*.supabase.co",
      "tcgplayer-cdn.tcgplayer.com",
      "static.cardmarket.com",
    ]) {
      expect(csp.includes(host), `img-src missing ${host}`).toBe(true);
    }
    expect(csp.includes("frame-ancestors 'none'")).toBe(true);
    expect(csp.includes("object-src 'none'")).toBe(true);
  });
});
