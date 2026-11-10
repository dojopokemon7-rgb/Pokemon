import { describe, it, expect } from "vitest";
import nextConfig from "../../next.config";

// Guards sec-audit-3 Finding #1 (HIGH): the app must ship application
// security headers on every response. This asserts next.config's headers()
// emits a global `/:path*` entry carrying each required header, so a future
// edit can't silently drop them. (A real CSP block check needs a browser;
// the CSP is ENFORCING — see the comment in next.config.ts.)
// The app entry excludes the landing paths (see next.config.ts securityHeaders).
const APP_SOURCE = "/((?!landing/|privacy$|grading-services$).+)";
const csp = (e?: { headers: { key: string; value: string }[] }) =>
  e!.headers.find((h) => h.key === "Content-Security-Policy")!.value;

describe("landing CSP scoping (GA4)", () => {
  it("GA origins only on landing entries, never on the app entry", async () => {
    const entries = await nextConfig.headers!();
    expect(csp(entries.find((e) => e.source === APP_SOURCE))).not.toContain("googletagmanager");
    for (const s of ["/", "/privacy", "/grading-services", "/landing/:path*"]) {
      const c = csp(entries.find((e) => e.source === s));
      expect(c, s).toContain("https://www.googletagmanager.com");
      expect(c, s).toContain("https://*.google-analytics.com");
    }
  });
  it("the app regex excludes landing paths and includes app paths", () => {
    const re = new RegExp(`^${APP_SOURCE}$`);
    for (const p of ["/privacy", "/grading-services", "/landing/assets/x.js", "/"]) expect(re.test(p), p).toBe(false);
    for (const p of ["/login", "/api/x", "/dashboard", "/privacy-x", "/admin/grading-interest"]) expect(re.test(p), p).toBe(true);
  });
});

describe("next.config security headers", () => {
  it("emits the app security-headers entry (every route except the landing)", async () => {
    expect(typeof nextConfig.headers).toBe("function");
    const entries = await nextConfig.headers!();

    const global = entries.find((e) => e.source === APP_SOURCE);
    expect(global, "an app (non-landing) headers entry must exist").toBeDefined();

    const keys = new Set(global!.headers.map((h) => h.key));
    for (const required of [
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
      "Strict-Transport-Security",
      "Permissions-Policy",
      "Content-Security-Policy",
    ]) {
      expect(keys.has(required), `missing ${required}`).toBe(true);
    }
    // CSP must be ENFORCING, not Report-Only.
    expect(keys.has("Content-Security-Policy-Report-Only")).toBe(false);

    // The existing PWA cache entries must survive alongside the new block.
    expect(entries.some((e) => e.source === "/sw.js")).toBe(true);
    expect(entries.some((e) => e.source === "/manifest.json")).toBe(true);
  });

  it("CSP covers every image origin the browser loads card art from", async () => {
    const entries = await nextConfig.headers!();
    const global = entries.find((e) => e.source === APP_SOURCE)!;
    const csp = global.headers.find(
      (h) => h.key === "Content-Security-Policy"
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

  it("CSP keeps the scanner's tesseract.js OCR fallback working under enforcement", async () => {
    const entries = await nextConfig.headers!();
    const global = entries.find((e) => e.source === APP_SOURCE)!;
    const csp = global.headers.find((h) => h.key === "Content-Security-Policy")!.value;

    // tesseract.js (scanner/page.tsx runTesseract) pulls its worker script +
    // WASM core + `eng` traineddata from cdn.jsdelivr.net, compiles WASM, and
    // runs in a blob Web Worker. Enforcing CSP would BREAK OCR without these.
    expect(csp, "script-src must allow jsdelivr").toMatch(
      /script-src[^;]*https:\/\/cdn\.jsdelivr\.net/
    );
    expect(csp, "script-src must allow wasm compile").toMatch(
      /script-src[^;]*'wasm-unsafe-eval'/
    );
    expect(csp, "connect-src must allow jsdelivr").toMatch(
      /connect-src[^;]*https:\/\/cdn\.jsdelivr\.net/
    );
    expect(csp, "worker-src must allow blob").toMatch(/worker-src[^;]*blob:/);
  });
});
