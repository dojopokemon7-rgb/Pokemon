import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Enable standalone output for Docker multi-stage builds.
  // This copies only the necessary files for production, drastically
  // reducing the final image size.
  output: "standalone",

  // Pin the file-tracing root to THIS project dir. Without it, Next infers
  // the root from the nearest lockfile — and when this checkout lives inside
  // another repo (e.g. a git worktree nested under a parent that has its own
  // package-lock.json), Next picks the PARENT and nests the standalone output
  // under `.next/standalone/<subpath>/server.js`, so the Playwright webServer's
  // `node .next/standalone/server.js` can't find it. Pinning the root keeps
  // the standalone server at `.next/standalone/server.js` everywhere.
  outputFileTracingRoot: import.meta.dirname,

  // Allow Next.js to serve images from Supabase Storage
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },

  // Explicitly mark server-only packages so they are not bundled into
  // client-side code. Add more as the project grows.
  serverExternalPackages: ["@prisma/client", "ioredis"],

  // Perf: tree-shake barrel-exported client libs so only the symbols actually
  // imported ship to the browser (smaller first-load JS → faster TTI). Safe +
  // additive; no behaviour change. Add libs here as heavy client deps appear.
  experimental: {
    optimizePackageImports: ["@tanstack/react-query"],
  },

  // -----------------------------------------------------------------
  // PWA headers
  // -----------------------------------------------------------------
  // `sw.js` is registered with scope "/" (see PwaRegistrar.tsx). Browsers
  // only allow a service worker to control a scope equal to or "below"
  // the directory it's served from — Service-Worker-Allowed widens that
  // to the whole origin, which is required since /sw.js technically lives
  // at the site root already but some browsers (older Safari) still
  // check this header explicitly.
  //
  // `sw.js` must also never be cached by the browser/CDN: if a stale copy
  // is served, users can get stuck on an old version of the app shell
  // indefinitely. `manifest.json` is safe to revalidate frequently too,
  // since it's tiny and install-metadata changes should propagate fast.
  async headers() {
    return [
      // -----------------------------------------------------------------
      // Application security headers (sec-audit-3 Finding #1, HIGH)
      // -----------------------------------------------------------------
      // On Vercel the app previously shipped ZERO security headers (the
      // Caddyfile sets a few, but only in a local :80 block that is NOT in
      // the Vercel ingress path). This global `/:path*` entry closes that
      // gap for every response.
      //
      // CSP is shipped as Content-Security-Policy-REPORT-ONLY (not enforcing)
      // on purpose. Two real client-side loads reach ORIGINS not covered by a
      // `'self'`-only policy, and we cannot confirm them in a browser here:
      //   1. The scanner's on-device OCR fallback (F-14) dynamically imports
      //      tesseract.js, which — with no corePath/langPath override (see
      //      scanner/page.tsx runTesseract) — fetches its WASM core and the
      //      `eng` traineddata from https://cdn.jsdelivr.net at runtime. That
      //      needs connect-src/script-src for jsdelivr + worker-src blob:,
      //      none of which are in the directive set below.
      //   2. Next.js injects inline runtime bootstrap + styles, so
      //      script-src/style-src keep 'unsafe-inline' (tightening to a nonce
      //      is a deliberate future task — do NOT attempt nonces here).
      // Report-Only lets the browser REPORT what the policy WOULD block
      // without breaking the scanner or anything else, so the directives can
      // be verified against real traffic before flipping to enforcing. To
      // enforce later: rename the key to "Content-Security-Policy", add
      // `https://cdn.jsdelivr.net` to connect-src + script-src and
      // `worker-src 'self' blob:`, then confirm the scanner still OCRs.
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Double-covered with CSP `frame-ancestors 'none'` below — both are
          // intentional (older browsers honor only one).
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            // camera=(self): the scanner uses getUserMedia on its own page.
            // microphone/geolocation are disabled app-wide.
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(), geolocation=()",
          },
          {
            key: "Content-Security-Policy-Report-Only",
            value: [
              "default-src 'self'",
              // img-src: every host the browser loads card art from directly.
              //   Pokémon art — kept in exact sync with the /api/card-img
              //   proxy allowlist + next.config remotePatterns (images.scrydex.com,
              //   assets.tcgdex.net, images.pokemontcg.io, *.supabase.co).
              //   One Piece art — the UI <img> loads these two upstreams
              //   DIRECTLY (card.service.ts: "the browser can embed them
              //   directly"; card-image.ts onError chain): tcgplayer-cdn and
              //   static.cardmarket.com. data:/blob: cover the scanner canvas.
              "img-src 'self' data: blob: https://*.supabase.co https://images.scrydex.com https://assets.tcgdex.net https://images.pokemontcg.io https://tcgplayer-cdn.tcgplayer.com https://static.cardmarket.com",
              // 'unsafe-inline' required by Next.js inline runtime/styles.
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              // All client fetches hit same-origin /api/* (sec-audit-2 #14).
              // NOTE: tesseract.js jsdelivr fetch is the one exception — see
              // the Report-Only rationale above.
              "connect-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "object-src 'none'",
            ].join("; "),
          },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Service-Worker-Allowed", value: "/" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
      {
        source: "/manifest.json",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Content-Type", value: "application/manifest+json" },
        ],
      },
    ];
  },
};

export default nextConfig;
