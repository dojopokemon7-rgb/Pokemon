import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Enable standalone output for Docker multi-stage builds.
  // This copies only the necessary files for production, drastically
  // reducing the final image size.
  output: "standalone",

  // Don't advertise the framework. Next.js sends `X-Powered-By: Next.js` by
  // default; an OWASP ZAP baseline scan flagged it as an information leak
  // (fingerprinting aid). Harmless on its own but trivially removable.
  poweredByHeader: false,

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
      // CSP is ENFORCING (Content-Security-Policy). Every origin the app
      // genuinely loads is allowlisted per-directive below; nothing else is
      // permitted. Two real client-side loads shaped the directive set:
      //   1. The scanner's on-device OCR fallback (F-14) dynamically imports
      //      tesseract.js, which — with no corePath/langPath override (see
      //      scanner/page.tsx runTesseract, `ocr(canvas, "eng")`) — pulls its
      //      worker script, WASM core, and `eng` traineddata from
      //      https://cdn.jsdelivr.net at runtime, and compiles WASM in a blob
      //      Web Worker. That is why jsdelivr is on script-src + connect-src,
      //      why script-src carries 'wasm-unsafe-eval' (WASM compile), and why
      //      worker-src is 'self' blob:. These are the MINIMUM additions that
      //      keep the OCR fallback working under an enforcing policy.
      //   2. Next.js injects inline runtime bootstrap + styles, so
      //      script-src/style-src keep 'unsafe-inline' (tightening to a nonce
      //      is a deliberate future task — do NOT attempt nonces here).
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
            key: "Content-Security-Policy",
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
              // 'wasm-unsafe-eval' lets tesseract.js compile its WASM core.
              // cdn.jsdelivr.net hosts the tesseract.js worker script.
              "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
              "style-src 'self' 'unsafe-inline'",
              // App fetches hit same-origin /api/* (sec-audit-2 #14); the ONE
              // cross-origin fetch is tesseract.js pulling its WASM core +
              // `eng` traineddata from cdn.jsdelivr.net (scanner OCR fallback).
              "connect-src 'self' https://cdn.jsdelivr.net",
              // tesseract.js runs OCR in a blob-URL Web Worker.
              "worker-src 'self' blob:",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              // form-action must allow Google's OAuth endpoints: the Google
              // sign-in flow submits/redirects a form to accounts.google.com,
              // which a bare `form-action 'self'` BLOCKED — breaking Google
              // login on mobile (the /api/auth/callback/google navigation
              // failed with ERR_FAILED). 'self' covers our own email/password
              // + credential forms; the Google origins cover social sign-in.
              "form-action 'self' https://accounts.google.com https://*.google.com",
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
